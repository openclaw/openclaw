require "json"
require "open3"

module WatchRuntimeAdmission
  class Unavailable < StandardError; end

  def self.wait!(runtime)
    # Deleting a stale registration can unmount the Ready image shared by both.
    # Let CoreSimulator finish that work before creating our Watch session.
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 120
    previous = nil
    removed = []
    loop do
      output, error, status = Open3.capture3("xcrun", "simctl", "runtime", "list", "-j")
      raise "Cannot inspect Watch runtime cleanup: #{error.strip}" unless status.success?
      images = JSON.parse(output).values.select { |image| image["runtimeIdentifier"] == runtime }
      return images if images.empty?

      mounts, error, status = Open3.capture3("/sbin/mount")
      raise "Cannot inspect Watch runtime mounts: #{error.strip}" unless status.success?
      facts = images.map do |image|
        path = image["mountPath"]
        bundle = image["runtimeBundlePath"]
        mounted = path && mounts.lines.any? { |line| line.include?(" on #{path} (") }
        { "runtime" => image["runtimeIdentifier"], "state" => image["state"], "mounted" => !!mounted, "bundleExists" => !!(bundle && File.directory?(bundle)) }
      end
      ready = facts.all? { |image| image["state"] == "Ready" && image["mounted"] && image["bundleExists"] } &&
        facts.group_by { |image| image["runtime"] }.values.all? { |entries| entries.length == 1 }
      return images if ready

      if facts != previous
        FastlaneCore::UI.important("Waiting for Watch runtime cleanup: #{JSON.generate(facts)}")
        previous = facts
      end
      # CoreSimulator can retain unmounted unusable registrations after replacing
      # their image. Retire those registrations without purging the shared asset.
      stale = images.zip(facts).select do |image, fact|
        fact["state"] == "Unusable" && !fact["mounted"] && !removed.include?(image.fetch("identifier")) &&
          facts.count { |entry| entry["runtime"] == fact["runtime"] && entry["state"] == "Ready" && entry["mounted"] && entry["bundleExists"] } == 1
      end
      unless stale.empty?
        stale.each do |image, _|
          identifier = image.fetch("identifier")
          FastlaneCore::UI.important("Retiring unmounted unusable Watch registration #{identifier}")
          _, error, status = Open3.capture3("xcrun", "simctl", "runtime", "delete", identifier, "--keep-asset")
          raise "Cannot retire stale Watch registration: #{error.strip}" unless status.success?
          removed << identifier
        end
        _, error, status = Open3.capture3("xcrun", "simctl", "runtime", "scan-and-mount")
        raise "Cannot remount Watch runtime after stale registration cleanup: #{error.strip}" unless status.success?
      end
      if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
        available = facts.any? do |image|
          image["runtime"] == runtime && image["state"] == "Ready" && image["mounted"] && image["bundleExists"]
        end
        raise Unavailable, "#{runtime} is not mounted with an available runtime bundle" unless available
        raise "Watch runtime cleanup did not settle before simulator admission"
      end
      sleep(2)
    end
  end
end
