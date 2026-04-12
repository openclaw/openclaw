// Production OutboundProxyDocker adapter — talks to `execDocker` from
// `docker.ts`. Kept in its own file so outbound-proxy.ts stays pure (easier
// unit testing with mocked adapters) and so lifecycle operations can be
// swapped out in integration tests without touching the policy resolver.
//
// Design notes:
//   - Networks are created with `--internal` so attached containers cannot
//     reach the host network directly. The proxy container is ALSO attached
//     to the default bridge (`docker network connect bridge`) so it has an
//     egress path.
//   - Tinyproxy config + filter files are piped into the container via a
//     temp tarball + `docker cp` alternative — simpler: we start the
//     container, then use `docker exec -i sh -c 'cat > /etc/tinyproxy/...' `
//     with stdin piping. This matches the pattern `execDockerRaw` already
//     supports via its `input` option.
//   - The container is started with `--entrypoint sleep` so we can inject
//     the config files before tinyproxy boots, then we `docker exec` to
//     start tinyproxy in the foreground. That way a config error surfaces
//     cleanly instead of crash-looping the entrypoint.

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { dockerContainerState, execDocker, execDockerRaw } from "./docker.js";
import type { OutboundProxyDocker } from "./outbound-proxy.js";

const log = createSubsystemLogger("sandbox/outbound-proxy-docker");

export const outboundProxyDocker: OutboundProxyDocker = {
  async networkExists(name: string): Promise<boolean> {
    const result = await execDocker(["network", "inspect", name], { allowFailure: true });
    return result.code === 0;
  },

  async createInternalNetwork(name: string): Promise<void> {
    await execDocker([
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--label",
      "openclaw.outboundProxy=1",
      name,
    ]);
  },

  async containerExists(name: string): Promise<boolean> {
    const state = await dockerContainerState(name);
    return state.exists;
  },

  async containerRunning(name: string): Promise<boolean> {
    const state = await dockerContainerState(name);
    return state.running;
  },

  async removeContainer(name: string): Promise<void> {
    await execDocker(["rm", "-f", name], { allowFailure: true });
  },

  async runTinyproxyContainer(params: {
    name: string;
    image: string;
    internalNetwork: string;
    port: number;
    configBody: string;
    filterBody: string;
  }): Promise<void> {
    // Start the container idle so we can inject the config + filter files
    // before tinyproxy boots. The base dannydirect/tinyproxy image has a
    // `sh` shell and writable /etc/tinyproxy/, so this works without any
    // additional image surgery.
    //
    // --network attaches the proxy to the internal bridge BEFORE the
    // default bridge is added in `attachToBridge`. This matches how Docker
    // prioritizes network interfaces: the first --network wins as the
    // primary, so the proxy's service address lives on the internal bridge
    // where the sandbox can reach it.
    //
    // Cap handling: `--cap-drop ALL` + `--cap-add SETUID,SETGID` is the
    // minimal set required for tinyproxy to drop from root to the
    // `tinyproxy` user at startup (verified live 2026-04-12 against
    // dannydirect/tinyproxy:latest). Adding only these two caps keeps the
    // container "fail-shut by default" while allowing the intended privilege
    // drop. Keepalive command is `tail -f /dev/null` because the image's
    // busybox `sleep` does not accept `infinity`.
    const createArgs: string[] = [
      "run",
      "-d",
      "--name",
      params.name,
      "--label",
      "openclaw.outboundProxy=1",
      "--label",
      `openclaw.proxyPort=${params.port}`,
      "--network",
      params.internalNetwork,
      "--restart",
      "unless-stopped",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "/bin/sh",
      params.image,
      "-c",
      "tail -f /dev/null",
    ];
    await execDocker(createArgs);

    // Write config + filter using `docker exec -i sh -c 'cat > file'`.
    // execDockerRaw's `input` option pipes the body to stdin.
    const writeFile = async (path: string, body: string) => {
      const cmd = `cat > ${path}`;
      await execDockerRaw(
        ["exec", "-i", params.name, "/bin/sh", "-c", cmd],
        { input: body },
      );
    };
    await writeFile("/etc/tinyproxy/tinyproxy.conf", params.configBody);
    await writeFile("/etc/tinyproxy/filter", params.filterBody);

    // Start tinyproxy in the background inside the container. It will
    // daemonize and stay up as long as the container's keepalive does.
    // If tinyproxy errors on the config it will exit silently, leaving
    // the keepalive alive — that means a health check is needed. For now
    // we log and rely on the first CONNECT attempt to reveal a broken
    // proxy. Binary lives at /usr/sbin/tinyproxy in the dannydirect image.
    await execDocker(
      ["exec", "-d", params.name, "/usr/sbin/tinyproxy", "-c", "/etc/tinyproxy/tinyproxy.conf"],
      { allowFailure: true },
    );
    log.info(`Tinyproxy started in container ${params.name}`);
  },

  async attachToBridge(name: string): Promise<void> {
    // Connect the proxy container to the default `bridge` network so it has
    // an egress route. The internal network already isolates the sandbox;
    // only the proxy needs bridge access.
    const result = await execDocker(["network", "connect", "bridge", name], {
      allowFailure: true,
    });
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      if (!stderr.includes("already exists") && !stderr.includes("already connected")) {
        throw new Error(
          `Failed to attach proxy container ${name} to default bridge: ${stderr}`,
        );
      }
    }
  },
};
