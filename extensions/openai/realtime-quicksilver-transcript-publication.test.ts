import { expect, it, onTestFinished, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import { publicDelegation } from "./realtime-quicksilver-events.test-support.js";
import { fakeQuicksilverMediaSocket } from "./realtime-quicksilver-socket.test-support.js";
import {
  createDelegationHarness,
  emitSideband,
  FakeSocket,
  publicTranscript,
} from "./realtime-quicksilver.test-helpers.js";

type Observer = (role: "user" | "assistant", text: string, final: boolean) => void;
async function createPublisher(kind: "controller" | "direct", onTranscript: Observer) {
  const consult = vi.fn(async (_request?: unknown) => ({ text: "Done" }));
  if (kind === "controller") {
    const { controller } = createDelegationHarness({
      model: "gpt-live-1",
      onTranscript,
      runAgentConsult: consult,
    });
    return {
      consult,
      frame: (event: unknown) => controller.handleFrame(Buffer.from(JSON.stringify(event)), false),
      stop: async (_restart = false) => controller.stop(new Error("test closed")),
    };
  }
  const sockets: FakeSocket[] = [];
  const bridge = new OpenAIQuicksilverVoiceBridge(
    {
      providerConfig: {},
      model: "gpt-live-1",
      onTranscript,
      onToolCall: (event) => void consult(event),
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      resolveAuth: async () => ({ type: "api-key", token: "fixture-key" }),
      mediaSocketFactory: fakeQuicksilverMediaSocket(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }),
    },
    openAIRealtimeHost,
  );
  const ready = async (connecting: Promise<void>, index: number) => {
    await vi.waitFor(() => expect(sockets[index]?.sent.length).toBe(1));
    emitSideband(sockets[index]!, { type: "session.started", session: {} });
    await connecting;
  };
  await ready(bridge.connect(), 0);
  return {
    consult,
    frame: (event: unknown) => emitSideband(sockets.at(-1)!, event),
    stop: async (restart = false) => {
      const oldSocket = sockets.at(-1)!;
      const closing = bridge.close();
      const index = sockets.length;
      const connecting = restart ? bridge.connect() : undefined;
      emitSideband(oldSocket, { type: "session.closed", reason: "close_requested" });
      await closing;
      if (connecting) {
        await ready(connecting, index);
      }
    },
  };
}
it.each(["controller", "direct"] as const)(
  "%s publishes per-role aggregates independently of bounded context",
  async (kind) => {
    const pending = { user: "", assistant: "" };
    const finals: Array<{ role: string; text: string }> = [];
    const client = await createPublisher(kind, (role, text, final) => {
      if (final) {
        expect(text).toBe(pending[role]);
        finals.push({ role, text });
        pending[role] = "";
      } else {
        pending[role] += text;
      }
    });
    onTestFinished(() => client.stop());
    const request = "word".repeat(300);
    client.frame(publicTranscript("user", "Check "));
    client.frame(publicTranscript("assistant", "I can help."));
    client.frame(publicTranscript("user", request));
    client.frame(publicDelegation("interleave", 100));
    expect(finals.filter((entry) => entry.role === "user")).toEqual([
      { role: "user", text: "Check " + request },
    ]);
    const checkpoint = finals.length;
    const oversized = "é".repeat(5_000);
    client.frame(publicTranscript("user", oversized));
    client.frame(publicDelegation("oversized", 100));
    const savedUser = finals.slice(checkpoint).filter((entry) => entry.role === "user");
    expect(savedUser.length).toBeGreaterThan(1);
    expect(savedUser.map((entry) => entry.text).join("")).toBe(oversized);
    const beforeClose = finals.length;
    await client.stop();
    expect(finals).toHaveLength(beforeClose);
  },
);

it.each([
  { kind: "controller", restart: false },
  { kind: "direct", restart: false },
  { kind: "direct", restart: true },
] as const)(
  "$kind checkpoint respects closing/replacement (restart=$restart)",
  async ({ kind, restart }) => {
    const order: string[] = [];
    const partials: string[] = [];
    const finals: string[] = [];
    let stopping: Promise<void> | undefined;
    const client = await createPublisher(kind, (role, text, final) => {
      if (!final) {
        partials.push(text);
        return;
      }
      order.push(`start:${role}`);
      finals.push(text);
      stopping ??= client.stop(restart);
      order.push(`end:${role}`);
    });
    onTestFinished(() => client.stop());
    const user = "u".repeat(7_000);
    const assistant = "a".repeat(900);
    client.frame(publicTranscript("user", user));
    client.frame(publicTranscript("assistant", assistant));
    client.frame(publicTranscript("user", "never-admitted".repeat(20)));
    await stopping;
    expect(partials).toEqual([user, assistant]);
    expect(order).toEqual(
      restart
        ? ["start:user", "end:user"]
        : ["start:user", "end:user", "start:assistant", "end:assistant"],
    );
    expect(finals).toEqual(restart ? [user] : [user, assistant]);
    if (restart) {
      client.frame(publicTranscript("user", "Fresh request"));
      client.frame(publicDelegation("fresh", 100));
      expect(finals.at(-1)).toBe("Fresh request");
    } else {
      client.frame(publicDelegation("late", 100));
      expect(client.consult).not.toHaveBeenCalled();
    }
  },
);
