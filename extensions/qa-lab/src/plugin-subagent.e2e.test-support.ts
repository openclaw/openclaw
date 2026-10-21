import path from "node:path";
import { expect } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

export async function startSubagentFixture(
  plugin: string,
  cleanups: Array<() => Promise<void>>,
  packaged = false,
) {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const bus = await startQaBusServer({ state });
  cleanups.push(() => bus.stop());
  const mock = await startQaMockOpenAiServer();
  cleanups.push(() => mock.stop());
  const owner = createQaGatewayChild();
  cleanups.push(async () => {
    expect((await owner.stop()).errors).toEqual([]);
  });
  const gateway = await owner.start({
    repoRoot,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    providerMode: "mock-openai",
    transport,
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
    ...(packaged
      ? {
          mockSessionObserverUrl: mock.sessionObserverUrl,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "dist/index.js")],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
        }
      : { useRepoCli: true }),
    mutateConfig: (config) => {
      const plugins = (config.plugins ??= {});
      const id = `qa-${plugin}-subagent`;
      plugins.enabled = true;
      plugins.allow = [...new Set([...(plugins.allow ?? []), id])];
      const load = (plugins.load ??= {});
      load.paths = [
        ...new Set([
          ...(load.paths ?? []),
          path.join(repoRoot, `extensions/qa-lab/test-fixtures/${plugin}-subagent-plugin`),
        ]),
      ];
      plugins.entries = { ...plugins.entries, [id]: { enabled: true } };
      return config;
    },
  });
  await transport.waitReady({ gateway });
  const outbound = () =>
    state.getSnapshot().messages.filter(({ direction }) => direction === "outbound");
  return { state, transport, mock, gateway, outbound };
}
