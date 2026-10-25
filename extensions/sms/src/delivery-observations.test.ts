import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createSmsDeliveryRecorder,
  isTwilioDeliveryStatusForm,
  listRecentSmsDeliveryRecords,
  recordInitialSmsDeliveryResult,
  type SmsDeliveryRecord,
} from "./delivery-observations.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsTestAccount } from "./webhook.test-support.js";

const getSmsRuntime = vi.hoisted(() => vi.fn());
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getSmsRuntime,
}));

function createAccount(
  accountId = "default",
  overrides: Partial<ResolvedSmsAccount> = {},
): ResolvedSmsAccount {
  return createSmsTestAccount({ accountId, ...overrides });
}

function createStore(): PluginStateKeyedStore<SmsDeliveryRecord> {
  const values = new Map<string, SmsDeliveryRecord>();
  const observe = (key: string) => ({
    value: structuredClone(values.get(key)),
    comparison: JSON.stringify(values.get(key)) ?? "missing",
  });
  const store: PluginStateKeyedStore<SmsDeliveryRecord> = {
    register: async (key, value) => void values.set(key, value),
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    observe: async (key) => observe(key),
    async compareAndApply(key, comparison, intent) {
      const current = observe(key);
      if (comparison !== current.comparison) {
        return { status: "conflict", current };
      }
      if (intent.action === "keep") {
        return { status: "unchanged" };
      }
      if (intent.action === "delete") {
        return { status: values.delete(key) ? "applied" : "unchanged" };
      }
      values.set(key, structuredClone(intent.value));
      return { status: "applied" };
    },
    lookup: async (key) => values.get(key),
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: async (key) => values.delete(key),
    entries: async () =>
      [...values].map(([key, value]) => ({ key, value, createdAt: value.lastObservedAt })),
    clear: async () => values.clear(),
  };
  getSmsRuntime.mockReturnValue({ state: { openKeyedStore: () => store } });
  return store;
}

async function latestRecord(): Promise<SmsDeliveryRecord> {
  const record = (await listRecentSmsDeliveryRecords(createAccount()))[0];
  if (!record) {
    throw new Error("test invariant: expected an SMS delivery record");
  }
  return record;
}

async function recordApiStatus(
  status: string,
  observedAt: number,
  sid = "SM123",
): Promise<SmsDeliveryRecord> {
  using now = vi.spyOn(Date, "now");
  now.mockReturnValue(observedAt);
  await recordInitialSmsDeliveryResult({
    account: createAccount(),
    result: { sid, to: "+15551234567", status },
  });
  return await latestRecord();
}

function statusForm(status: string, fields: Record<string, string> = {}) {
  return { MessageSid: "SM123", MessageStatus: status, ...fields };
}

async function recordCallback(form: Record<string, string>, observedAt?: number) {
  const now =
    observedAt === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(observedAt);
  try {
    return await createSmsDeliveryRecorder().record({ account: createAccount(), form });
  } finally {
    now?.mockRestore();
  }
}

describe("SMS delivery observations", () => {
  it("parses current and legacy status fields without retaining message content", async () => {
    createStore();
    const privateFields = {
      AccountSid: "AC123",
      From: "+15557654321",
      To: "+15551234567",
      Body: "private message",
      ErrorCode: "30005",
      RawDlrDoneDate: "2608021200",
    };
    const current = await recordCallback(statusForm("undelivered", privateFields), 100);
    const legacy = await recordCallback(
      {
        ...privateFields,
        From: "+15550000000",
        To: "+15559999999",
        Body: "different private message",
        SmsSid: "SM123",
        SmsStatus: "undelivered",
      },
      200,
    );

    expect(current).toMatchObject({
      duplicate: false,
      record: {
        messageSid: "SM123",
        status: "undelivered",
        observations: [
          {
            source: "callback",
            status: "undelivered",
            observedAt: 100,
            errorCode: "30005",
            rawDlrDoneDate: "2608021200",
          },
        ],
      },
    });
    expect(legacy).toMatchObject({
      duplicate: true,
      record: { observations: [{ observedAt: 100 }] },
    });
    expect(JSON.stringify(current.record)).not.toContain("+1555");
    expect(JSON.stringify(current.record)).not.toContain("private message");
    expect(JSON.stringify(current.record)).not.toContain("AC123");
  });

  it("rejects legacy inbound status observations", async () => {
    createStore();
    const form = { MessageSid: "SM123", SmsStatus: "receiving" };

    expect(isTwilioDeliveryStatusForm(form)).toBe(false);
    await expect(recordCallback(form)).rejects.toThrow("Invalid Twilio delivery status callback.");
  });

  it.each(["accepted", "scheduled"])(
    "advances a message from its %s initial state through sent",
    async (initialStatus) => {
      createStore();
      for (const [index, status] of [initialStatus, "queued", "sending", "sent"].entries()) {
        const current = await recordApiStatus(status, index + 1);
        expect(current.status).toBe(status);
      }

      await recordCallback({ MessageSid: "SM123", MessageStatus: "queued" }, 10);
      expect((await latestRecord()).status).toBe("sent");
    },
  );

  it.each([
    ["scheduled", "canceled", 1, 2, { status: "canceled" }],
    [
      "delivered",
      "sent",
      200,
      300,
      {
        status: "delivered",
        firstObservedAt: 200,
        lastObservedAt: 300,
        observations: [{ status: "delivered" }, { status: "sent" }],
      },
    ],
  ] as const)("reduces API transition %s → %s", async (first, next, start, end, expected) => {
    createStore();
    await recordApiStatus(first, start);
    expect(await recordApiStatus(next, end)).toMatchObject(expected);
  });

  it.each([
    ["failed", { status: "failed", errorCode: "30006", lastObservedAt: 200 }],
    ["delivered", { status: "conflicted", conflict: true, errorCode: "30006" }],
  ] as const)("reduces a failed callback after %s", async (first, expected) => {
    createStore();
    await recordCallback(statusForm(first), 100);
    expect(
      (await recordCallback(statusForm("failed", { ErrorCode: "30006" }), 200)).record,
    ).toMatchObject(expected);
  });

  it("deduplicates semantic retries despite unrelated form differences", async () => {
    createStore();
    const recorder = createSmsDeliveryRecorder();
    const first = {
      AccountSid: "AC123",
      From: "+15557654321",
      To: "+15551234567",
      Body: "first",
      MessageSid: "SM123",
      MessageStatus: "delivered",
    };
    const retry = {
      ...first,
      From: "+15550000000",
      To: "+15559999999",
      Body: "changed",
    };

    await expect(recorder.record({ account: createAccount(), form: first })).resolves.toMatchObject(
      {
        duplicate: false,
        record: { status: "delivered" },
      },
    );
    await expect(recorder.record({ account: createAccount(), form: retry })).resolves.toMatchObject(
      {
        duplicate: true,
        record: { observations: [{ status: "delivered" }] },
      },
    );
  });

  it.each([
    {
      secondStatus: "delivered",
      status: "delivered",
      duplicates: [false, true],
      lastObservedAt: 100,
      observations: [{ status: "delivered", observedAt: 100 }],
    },
    {
      secondStatus: "failed",
      status: "conflicted",
      duplicates: [false, false],
      lastObservedAt: 101,
      observations: [
        { status: "delivered", observedAt: 100 },
        { status: "failed", observedAt: 101 },
      ],
    },
  ])("retains concurrent $secondStatus observations", async (expected) => {
    createStore();
    using now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(100).mockReturnValueOnce(101);
    const results = await Promise.all(
      ["delivered", expected.secondStatus].map((status) =>
        recordInitialSmsDeliveryResult({
          account: createAccount(),
          result: { sid: "SM123", to: "+15551234567", status },
        }),
      ),
    );

    expect(results.map((result) => result?.duplicate)).toEqual(expected.duplicates);
    const record = await latestRecord();
    expect(record).toMatchObject({
      status: expected.status,
      firstObservedAt: 100,
      lastObservedAt: expected.lastObservedAt,
      observations: expected.observations,
    });
  });

  it("isolates records by local account and account SID but survives token rotation", async () => {
    createStore();
    await recordCallback(statusForm("delivered"));

    for (const account of [
      createAccount("support"),
      createAccount("default", { accountSid: "AC-other" }),
    ]) {
      await expect(listRecentSmsDeliveryRecords(account)).resolves.toEqual([]);
    }
    await expect(
      listRecentSmsDeliveryRecords(createAccount("default", { authToken: "rotated-secret" })),
    ).resolves.toMatchObject([{ accountId: "default", messageSid: "SM123", status: "delivered" }]);
  });

  it("records each successful API response and lets callbacks advance it", async () => {
    const store = createStore();
    for (const [index, status] of ["accepted", "scheduled", "queued"].entries()) {
      await recordApiStatus(status, index + 1, `SM-${status}`);
    }
    await recordCallback(statusForm("sent", { MessageSid: "SM-queued" }));

    expect((await store.entries()).map(({ value }) => value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageSid: "SM-accepted", status: "accepted" }),
        expect.objectContaining({ messageSid: "SM-scheduled", status: "scheduled" }),
        expect.objectContaining({
          messageSid: "SM-queued",
          status: "sent",
          observations: [
            expect.objectContaining({ source: "api-response", status: "queued" }),
            expect.objectContaining({ source: "callback", status: "sent" }),
          ],
        }),
      ]),
    );
  });

  it("skips API responses without an initial status", async () => {
    createStore();
    await expect(
      recordInitialSmsDeliveryResult({
        account: createAccount(),
        result: { sid: "SM123", to: "+15551234567" },
      }),
    ).resolves.toBeNull();
  });

  it("bounds retained observations per message", async () => {
    createStore();
    for (let index = 0; index < 25; index += 1) {
      await recordCallback(statusForm("queued", { RawDlrDoneDate: String(index) }), index);
    }

    const current = await latestRecord();
    expect(current.observations).toHaveLength(20);
    expect(current.observations[0]?.rawDlrDoneDate).toBe("5");
  });

  it("opens bounded plugin state and reopens it when the injected runtime changes", async () => {
    const firstStore = createStore();
    const secondStore = createStore();
    const firstOpen = vi.fn(() => firstStore);
    const secondOpen = vi.fn(() => secondStore);
    const account = createAccount();

    getSmsRuntime.mockReturnValue({ state: { openKeyedStore: firstOpen } });
    await listRecentSmsDeliveryRecords(account);
    getSmsRuntime.mockReturnValue({ state: { openKeyedStore: secondOpen } });
    await listRecentSmsDeliveryRecords(account);

    const expectedOptions = {
      namespace: "twilio-delivery-observations-v1",
      maxEntries: 5_000,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
    };
    expect(firstOpen).toHaveBeenCalledExactlyOnceWith(expectedOptions);
    expect(secondOpen).toHaveBeenCalledExactlyOnceWith(expectedOptions);
  });
});
