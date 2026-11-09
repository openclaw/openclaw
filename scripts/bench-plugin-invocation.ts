// Run with pnpm bench:plugins:invocation.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import { PluginInstance } from "../src/plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { createPluginRecord } from "../src/plugins/status.test-helpers.js";

const iterations = 10_000;
const instances: PluginInstance[] = [];
function instance(id: string) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id, origin: "bundled" });
  registry.plugins.push(record);
  const owner = new PluginInstance(id, { record, registry });
  instances.push(owner);
  return owner;
}

// Synthetic registered shapes isolate invocation overhead from network/storage work.
const channel = instance("channel-fixture");
const onEvent = (value: number) => value + 1;
const channelView = channel.wrap({
  callback: (callback: typeof onEvent) => callback(1),
  returned: () => ({ run: onEvent }),
  wrapper: (callback: typeof onEvent) => (value: number) => callback(value),
});
const returned = channelView.returned();
const wrapper = channelView.wrapper(onEvent);
const diagnostic = instance("diagnostics-fixture");
const observe = diagnostic.wrap({ observe: (_event: unknown) => undefined });
const event = { type: "model.usage", inputTokens: 12, outputTokens: 4 };
const catalog = instance("catalog-fixture");
const rows = Array.from({ length: 20 }, (_, index) => ({ id: String(index), title: "session" }));
const provider = catalog.wrap({ list: () => rows });
const scenarios = [
  { name: "diagnostics.observe", run: () => observe.observe(event) },
  { name: "sessionCatalog.list", run: () => provider.list() },
  { name: "channel.callback", run: () => channelView.callback(onEvent) },
  { name: "channel.returnedMethod", run: () => returned.run(1) },
  { name: "channel.returnedWrapper", run: () => wrapper(1) },
  { name: "channel.createReturnedWrapper", run: () => channelView.wrapper(onEvent)(1) },
];

try {
  const results = [];
  for (const scenario of scenarios) {
    for (let index = 0; index < iterations; index++) {
      scenario.run();
    }
    const samples = [];
    for (let sample = 0; sample < 7; sample++) {
      const start = performance.now();
      for (let index = 0; index < iterations; index++) {
        scenario.run();
      }
      samples.push(((performance.now() - start) * 1_000) / iterations);
    }
    let frames = 0;
    let wraps = 0;
    let entries = 0;
    const run = mock.method(AsyncLocalStorage.prototype, "run");
    const ProxyConstructor = Proxy;
    const enter = Reflect.get(PluginInstance.prototype, "enter");
    Reflect.set(
      PluginInstance.prototype,
      "enter",
      new Proxy(enter, {
        apply(target, receiver, args) {
          entries++;
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    globalThis.Proxy = new Proxy(ProxyConstructor, {
      construct(target, args) {
        wraps++;
        return Reflect.construct(target, args);
      },
    });
    try {
      for (let index = 0; index < iterations; index++) {
        scenario.run();
      }
      frames = run.mock.callCount();
    } finally {
      run.mock.restore();
      run.mock.resetCalls();
      globalThis.Proxy = ProxyConstructor;
      Reflect.set(PluginInstance.prototype, "enter", enter);
    }
    results.push({
      hook: scenario.name,
      usPerCall: samples.toSorted((a, b) => a - b)[3],
      framesPerCall: frames / iterations,
      wrapsPerCall: wraps / iterations,
      entriesPerCall: entries / iterations,
    });
  }
  console.log(JSON.stringify({ node: process.version, iterations, samples: 7, results }, null, 2));
} finally {
  await Promise.all(instances.map((owner) => owner.dispose()));
}
