import { describe, it } from "vitest";
import {
  DesktopLaunchParamsSchema,
  DesktopObserveResultSchema,
  WorkerDesktopObserveResultSchema,
  validateDesktopObserveParams,
} from "../index.js";
import { schemaValidation, validation } from "./protocol-validation.test-support.js";

const observed = {
  transport: "rfb",
  wsPath: "/desktop/observe?token=abc",
  expiresAtMs: 1,
  control: false,
};
const host = { kind: "host" };
const environment = { kind: "environment", environmentId: "worker:one" };
const node = { kind: "node", nodeId: "one" };
const credentials = { username: "operator", password: "secret" };
const observeResult = schemaValidation(DesktopObserveResultSchema);

describe("desktop protocol schemas", () => {
  it("advertises receive-only PCM with a fixed format", () => {
    const audio = {
      wsPath: "/desktop/audio",
      encoding: "pcm-s16le",
      sampleRate: 48000,
      channels: 2,
    };
    observeResult.accepts(
      observed,
      { ...observed, audio },
      { ...observed, audioUnavailableReason: "setup-unavailable" },
    );
    observeResult.rejects(
      { ...observed, audioUnavailableReason: "native stderr /private/path" },
      ...[{ encoding: "opus" }, { sampleRate: 24000 }, { channels: 1 }, { microphone: true }].map(
        (invalid) => Object.assign({}, observed, { audio: Object.assign({}, audio, invalid) }),
      ),
    );
  });
  it.each([DesktopObserveResultSchema, WorkerDesktopObserveResultSchema])(
    "keeps resize permission optional and boolean",
    (schema) => {
      const result = { ...observed, control: true };
      const resize = schemaValidation(schema);
      resize.accepts(result, { ...result, canResize: true }, { ...result, canResize: false });
      resize.rejects({ ...result, canResize: "true" });
    },
  );
  it("accepts host, environment and node sources with scoped credentials", () => {
    const observe = validation(validateDesktopObserveParams);
    observe.accepts(
      { source: host, control: true },
      { source: host, credentials },
      { source: environment },
      { source: node },
      { source: node, credentials },
      { source: node, credentials: { password: "secret" } },
    );
    observe.rejects(
      { source: { kind: "node", nodeId: "" } },
      { source: { kind: "future" } },
      { source: environment, credentials: { password: "secret" } },
      { source: host, credentials: { ...credentials, username: "" } },
      { source: { ...host, environmentId: "one" } },
    );
  });
  it("keeps launch environment-only and desktop auth additive", () => {
    const launch = schemaValidation(DesktopLaunchParamsSchema);
    launch.accepts({ source: environment, app: "browser" });
    launch.rejects({ source: host, app: "browser" });
    observeResult.accepts({ ...observed, auth: "ard-account", preauthenticated: true });
    observeResult.rejects({ ...observed, auth: "vencrypt" });
  });
});
