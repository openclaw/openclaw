// Msteams tests cover file consent plugin behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { describe, expect, it, vi } from "vitest";
import { uploadToConsentUrl } from "./file-consent.js";
import { resolveMSTeamsSharePointUploadTimeoutMs } from "./request-timeout.js";
import { buildUserAgent } from "./user-agent.js";

// Helper: a resolveFn that returns a public IP by default
const publicResolve = async () => ({ address: "13.107.136.10" });
// Helper: a resolveFn that returns a private IP
const privateResolve = (ip: string) => async () => ({ address: ip });
// Helper: a resolveFn that returns multiple addresses
const multiResolve = (ips: string[]) => async () => ips.map((address) => ({ address }));
// Helper: a resolveFn that fails
const failingResolve = async () => {
  throw new Error("DNS failure");
};

type ConsentValidationOptions = NonNullable<
  Parameters<typeof uploadToConsentUrl>[0]["validationOpts"]
>;

async function validateConsentUploadUrl(url: string, validationOpts?: ConsentValidationOptions) {
  await uploadToConsentUrl({
    url,
    buffer: Buffer.from("test"),
    fetchFn: async () => new Response(null, { status: 200 }),
    validationOpts,
  });
}

const responseWithCancel = (status: number, statusText?: string) => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  return { response: new Response(body, { status, statusText }), cancel };
};

// ─── validateConsentUploadUrl ────────────────────────────────────────────────

describe("validateConsentUploadUrl", () => {
  it("accepts graph.microsoft.com", async () => {
    await expect(
      validateConsentUploadUrl("https://graph.microsoft.com/v1.0/me/drive/items/123/content", {
        resolveFn: publicResolve,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid URLs", async () => {
    await expect(
      validateConsentUploadUrl("not a url", { resolveFn: publicResolve }),
    ).rejects.toThrow("not a valid URL");
  });

  it("rejects when DNS resolves to IPv6 loopback", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: privateResolve("::1"),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects when DNS resolves to IPv4-mapped IPv6 loopback", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: privateResolve("::ffff:127.0.0.1"),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects when any DNS answer is private/reserved", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: multiResolve(["13.107.136.10", "10.0.0.1"]),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("accepts when all DNS answers are public", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: multiResolve(["13.107.136.10", "52.96.0.1"]),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when DNS resolution fails", async () => {
    await expect(
      validateConsentUploadUrl("https://nonexistent.sharepoint.com/path", {
        resolveFn: failingResolve,
      }),
    ).rejects.toThrow("Failed to resolve");
  });

  it("accepts a custom allowlist", async () => {
    await expect(
      validateConsentUploadUrl("https://custom.example.org/file", {
        allowlist: ["example.org"],
        resolveFn: publicResolve,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects hosts that are suffix-tricked (e.g. notsharepoint.com)", async () => {
    await expect(
      validateConsentUploadUrl("https://notsharepoint.com/file", { resolveFn: publicResolve }),
    ).rejects.toThrow("not in the allowed domains");
  });
});

// ─── CONSENT_UPLOAD_HOST_ALLOWLIST ───────────────────────────────────────────

describe("CONSENT_UPLOAD_HOST_ALLOWLIST", () => {
  it.each([
    "sharepoint.com",
    "sharepoint.us",
    "sharepoint.de",
    "sharepoint.cn",
    "sharepoint-df.com",
    "storage.live.com",
    "onedrive.com",
    "1drv.ms",
    "graph.microsoft.com",
    "graph.microsoft.us",
    "graph.microsoft.de",
    "graph.microsoft.cn",
  ])("allows the expected Microsoft upload domain %s", async (domain) => {
    await expect(
      validateConsentUploadUrl(`https://${domain}/upload`, { resolveFn: publicResolve }),
    ).resolves.toBeUndefined();
  });

  it.each(["microsoft.com", "blob.core.windows.net"])(
    "rejects the overly broad domain %s",
    async (domain) => {
      await expect(
        validateConsentUploadUrl(`https://${domain}/upload`, { resolveFn: publicResolve }),
      ).rejects.toThrow("not in the allowed domains");
    },
  );
});

// ─── uploadToConsentUrl (integration with validation) ────────────────────────

describe("uploadToConsentUrl", () => {
  it("sends the OpenClaw User-Agent header with consent uploads", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await uploadToConsentUrl({
      url: "https://contoso.sharepoint.com/upload",
      buffer: Buffer.from("hello"),
      fetchFn,
      validationOpts: { resolveFn: publicResolve },
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, opts] = expectDefined(fetchFn.mock.calls[0], "fetch call");
    expect(url).toBe("https://contoso.sharepoint.com/upload");
    expect(opts?.method).toBe("PUT");
    expect(opts?.headers).toEqual({
      "Content-Range": "bytes 0-4/5",
      "Content-Type": "application/octet-stream",
      "User-Agent": buildUserAgent(),
    });
    expect(Buffer.from(await new Response(opts?.body).arrayBuffer())).toEqual(Buffer.from("hello"));
  });

  it("aborts consent uploads that do not finish before the request timeout", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const fetchFn = vi.fn<typeof fetch>(
        async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            observedSignal = init?.signal ?? undefined;
            observedSignal?.addEventListener(
              "abort",
              () => {
                const reason = observedSignal?.reason;
                reject(reason instanceof Error ? reason : new Error("request aborted"));
              },
              { once: true },
            );
          }),
      );

      const uploadPromise = uploadToConsentUrl({
        url: "https://contoso.sharepoint.com/upload",
        buffer: Buffer.from("hello"),
        fetchFn,
        timeoutMs: 25,
        validationOpts: { resolveFn: publicResolve },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(observedSignal?.aborted).toBe(false);
      const uploadRejection = expect(uploadPromise).rejects.toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });

      await vi.advanceTimersByTimeAsync(25);
      await uploadRejection;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows consent uploads that complete before the request timeout", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const fetchFn = vi.fn<typeof fetch>(
        async (_url, init) =>
          await new Promise<Response>((resolve, reject) => {
            observedSignal = init?.signal ?? undefined;
            observedSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("consent upload timed out", "AbortError")),
              { once: true },
            );
            setTimeout(() => resolve(new Response(null, { status: 200 })), 25);
          }),
      );

      const uploadPromise = uploadToConsentUrl({
        url: "https://contoso.sharepoint.com/upload",
        buffer: Buffer.from("hello"),
        fetchFn,
        timeoutMs: 50,
        validationOpts: { resolveFn: publicResolve },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(observedSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      await expect(uploadPromise).resolves.toBeUndefined();
      expect(observedSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows size-budgeted consent uploads that complete after the base upload deadline", async () => {
    vi.useFakeTimers();
    try {
      const buffer = Buffer.alloc(512 * 1024);
      const resolvedTimeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(buffer.length);
      const baseTimeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(0);
      const completionMs = baseTimeoutMs + 1_000;
      let observedSignal: AbortSignal | undefined;
      const fetchFn = vi.fn<typeof fetch>(
        async (_url, init) =>
          await new Promise<Response>((resolve, reject) => {
            observedSignal = init?.signal ?? undefined;
            observedSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("consent upload timed out", "AbortError")),
              { once: true },
            );
            setTimeout(() => resolve(new Response(null, { status: 200 })), completionMs);
          }),
      );

      expect(completionMs).toBeGreaterThan(baseTimeoutMs);
      expect(completionMs).toBeLessThan(resolvedTimeoutMs);

      const uploadPromise = uploadToConsentUrl({
        url: "https://contoso.sharepoint.com/upload",
        buffer,
        fetchFn,
        validationOpts: { resolveFn: publicResolve },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(observedSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(completionMs);
      await expect(uploadPromise).resolves.toBeUndefined();
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks upload to a disallowed host", async () => {
    const mockFetch = vi.fn();
    await expect(
      uploadToConsentUrl({
        url: "https://evil.example.com/exfil",
        buffer: Buffer.from("secret data"),
        fetchFn: mockFetch,
        validationOpts: { resolveFn: publicResolve },
      }),
    ).rejects.toThrow("not in the allowed domains");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks upload to a private IP", async () => {
    const mockFetch = vi.fn();
    await expect(
      uploadToConsentUrl({
        url: "https://compromised.sharepoint.com/upload",
        buffer: Buffer.from("data"),
        fetchFn: mockFetch,
        validationOpts: { resolveFn: privateResolve("10.0.0.1") },
      }),
    ).rejects.toThrow("private/reserved IP");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows upload to a valid SharePoint URL and performs PUT", async () => {
    const { response, cancel } = responseWithCancel(200);
    const backing = Buffer.from([0xfe, 0xfd, 1, 2, 3, 0xfc]);
    const buffer = backing.subarray(2, 5);
    const expectedBytes = Buffer.from([0, 0x80, 0xff]);
    let finishResolution: () => void = () => {};
    const resolutionReady = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const resolveFn = vi.fn(async () => {
      await resolutionReady;
      return { address: "13.107.136.10" };
    });
    const mockFetch = vi.fn<typeof fetch>(async (_url, init) => {
      backing.fill(0);
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(expectedBytes);
      return response;
    });

    const upload = uploadToConsentUrl({
      url: "https://contoso.sharepoint.com/sites/uploads/file.pdf",
      buffer,
      contentType: "application/pdf",
      fetchFn: mockFetch,
      validationOpts: { resolveFn },
    });
    await vi.waitFor(() => expect(resolveFn).toHaveBeenCalledOnce());
    expect(mockFetch).not.toHaveBeenCalled();
    expectedBytes.copy(buffer);
    finishResolution();
    await expect(upload).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = expectDefined(mockFetch.mock.calls[0], "fetch call");
    expect(url).toBe("https://contoso.sharepoint.com/sites/uploads/file.pdf");
    expect(opts?.method).toBe("PUT");
    expect(opts?.headers).toEqual({
      "User-Agent": buildUserAgent(),
      "Content-Type": "application/pdf",
      "Content-Range": "bytes 0-2/3",
    });
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(opts?.signal?.aborted).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("throws on non-OK response after passing validation", async () => {
    const { response, cancel } = responseWithCancel(403, "Forbidden");
    const mockFetch = vi.fn<typeof fetch>(async () => response);

    await expect(
      uploadToConsentUrl({
        url: "https://contoso.sharepoint.com/sites/uploads/file.pdf",
        buffer: Buffer.from("data"),
        fetchFn: mockFetch,
        validationOpts: { resolveFn: publicResolve },
      }),
    ).rejects.toThrow("File upload to consent URL failed: 403 Forbidden");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("blocks HTTP (non-HTTPS) upload before fetch is called", async () => {
    const mockFetch = vi.fn();
    await expect(
      uploadToConsentUrl({
        url: "http://contoso.sharepoint.com/upload",
        buffer: Buffer.from("data"),
        fetchFn: mockFetch,
        validationOpts: { resolveFn: publicResolve },
      }),
    ).rejects.toThrow("must use HTTPS");

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
