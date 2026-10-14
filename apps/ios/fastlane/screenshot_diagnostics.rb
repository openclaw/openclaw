# Opt-in incident evidence. Only fixed resource fields and crash metadata leave the host.
class ScreenshotDiagnostics
  attr_reader :events

  PROCESSES = %w[OpenClaw OpenClawUITests-Runner testmanagerd DTServiceHub Simulator com.apple.CoreSimulator.CoreSimulatorService].freeze

  def initialize(&persist)
    @events = []
    @persist = persist
    @hardware = {
      "logicalCpuCount" => command("/usr/sbin/sysctl", "-n", "hw.logicalcpu").to_i,
      "memoryBytes" => command("/usr/sbin/sysctl", "-n", "hw.memsize").to_i
    }
  end

  def measure(phase, device: nil, udid: nil, log_path: nil)
    started_at = Time.now
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    event = { "phase" => phase, "deviceName" => device, "startedAt" => started_at.utc.iso8601, "before" => resources }
    @events << event
    persist
    result = yield
    event["outcome"] = "succeeded"
    result
  rescue StandardError
    event["outcome"] = "failed"
    event["crashes"] = crashes_since(started_at, udid)
    raise
  ensure
    if event
      event["durationSeconds"] = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2)
      event["after"] = resources
      event["startup"] = startup_facts(log_path) if log_path
      persist
    end
  end

  private

  def persist
    @persist.call
  rescue SystemCallError
    UI.important("Could not save the optional screenshot diagnostic sample.")
  end

  def command(*arguments)
    Open3.popen2(*arguments, err: File::NULL, pgroup: true) do |input, output, process|
      input.close
      reader = Thread.new { output.read(256 * 1024) }
      unless process.join(3)
        Process.kill("KILL", -process.pid)
        process.join
      end
      result = reader.value
      process.value.success? ? result : ""
    end
  rescue SystemCallError
    ""
  end

  def resources
    statistics = command("/usr/bin/vm_stat")
    processes = command("/bin/ps", "-axo", "pcpu=,rss=,comm=").lines.filter_map do |line|
      match = line.match(/\A\s*([\d.]+)\s+(\d+)\s+(.+?)\s*\z/)
      next unless match
      name = File.basename(match[3])
      next unless PROCESSES.include?(name)
      { "name" => name, "cpuPercent" => match[1].to_f, "rssKiB" => match[2].to_i }
    end
    {
      "hardware" => @hardware,
      "loadAverage" => command("/usr/sbin/sysctl", "-n", "vm.loadavg").scan(/\d+(?:\.\d+)?/).map(&:to_f),
      "memoryPageBytes" => statistics[/page size of (\d+) bytes/, 1].to_i,
      "memoryPages" => statistics.lines.filter_map do |line|
        match = line.match(/\A(Pages (?:free|active|inactive|wired down|occupied by compressor)|Swapins|Swapouts):\s+(\d+)\./)
        [match[1], match[2].to_i] if match
      end.to_h,
      "processes" => processes
    }
  rescue StandardError
    { "unavailable" => true }
  end

  def startup_facts(path)
    facts = { "testCaseStarts" => 0, "instrumentsConnectionTimeout" => false, "runnerBootstrapFailure" => false, "stalledWait" => false }
    File.foreach(path) do |line|
      line = line.scrub
      facts["testCaseStarts"] += 1 if line.match?(/Test Case .* started\./)
      facts["instrumentsConnectionTimeout"] = true if line.include?("com.apple.instruments.deviceservice.lockdown") && line.include?("timed out")
      facts["runnerBootstrapFailure"] = true if line.include?("operation never finished bootstrapping")
      facts["stalledWait"] = true if line.include?("handleStalledWait:")
    end
    facts
  rescue SystemCallError
    { "unavailable" => true }
  end

  def crashes_since(started_at, udid)
    directories = [File.expand_path("~/Library/Logs/DiagnosticReports"), "/Library/Logs/DiagnosticReports"]
    if udid
      directories << File.expand_path("~/Library/Developer/CoreSimulator/Devices/#{udid}/data/Library/Logs/CrashReporter")
    end
    directories.flat_map { |directory| Dir[File.join(directory, "*.ips")] }
      .select { |path| File.mtime(path) >= started_at && File.size(path) <= 10 * 1024 * 1024 }
      .sort_by { |path| File.mtime(path) }.last(10).filter_map do |path|
        contents = File.read(path)
        report = begin
          JSON.parse(contents)
        rescue JSON::ParserError
          JSON.parse(contents.split("\n", 2).last)
        end
        name = report["procName"]
        next unless PROCESSES.include?(name)
        thread = Array(report["threads"]).find { |entry| entry["triggered"] }
        frames = Array(thread && thread["frames"]).first(12).filter_map do |frame|
          symbol = frame["symbol"].to_s
          next unless symbol.length <= 240 && symbol.match?(/\A[+\-\[A-Za-z_][A-Za-z0-9_ .():<>\[\]+\-]*\z/)
          { "symbol" => symbol }
        end
        {
          "process" => name,
          "exception" => report.fetch("exception", {}).slice("type", "signal").select { |_key, value| value.to_s.match?(/\A[A-Z_0-9]+\z/) },
          "termination" => report.fetch("termination", {}).slice("namespace", "code").select { |_key, value| value.is_a?(Numeric) || value.to_s.match?(/\A[A-Z_0-9]+\z/) },
          "triggeredThreadFrames" => frames
        }
      rescue JSON::ParserError, SystemCallError, TypeError
        nil
      end
  rescue StandardError
    []
  end
end
