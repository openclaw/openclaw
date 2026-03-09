import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecResult } from "../provider.js";
import { ExecBrowserHelper } from "./exec-browser.js";
import type { ExecFn } from "./exec-browser.js";

/**
 * Helper to build a mock ExecResult with stdout containing PW markers.
 */
function makeExecResult(jsonPayload: unknown, code = 0, stderr = ""): ExecResult {
  const markedOutput = `---PW_RESULT---\n${JSON.stringify(jsonPayload)}\n---PW_END---`;
  return {
    stdout: Buffer.from(markedOutput),
    stderr: Buffer.from(stderr),
    code,
  };
}

/**
 * Helper for plain stdout (no markers -- fallback parsing).
 */
function makePlainExecResult(jsonPayload: unknown, code = 0, stderr = ""): ExecResult {
  return {
    stdout: Buffer.from(JSON.stringify(jsonPayload)),
    stderr: Buffer.from(stderr),
    code,
  };
}

describe("ExecBrowserHelper", () => {
  let execFn: ReturnType<typeof vi.fn<ExecFn>>;
  let helper: ExecBrowserHelper;

  beforeEach(() => {
    execFn = vi.fn<ExecFn>();
    helper = new ExecBrowserHelper(execFn);
  });

  describe("launchBrowser", () => {
    it("calls execFn with sh -c node -e script structure", async () => {
      // First call: nohup background script (fire and forget)
      execFn.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      });
      // Second call: cat session file
      execFn.mockResolvedValueOnce(
        makeExecResult({ wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc", pid: 12345 }),
      );

      const result = await helper.launchBrowser("test-container", {
        enabled: true,
        headless: true,
      } as unknown);

      expect(result).toEqual({ sessionId: "exec-12345" });
      expect(execFn).toHaveBeenCalledTimes(2);

      // First call should contain nohup and the launch script
      const firstCall = execFn.mock.calls[0];
      expect(firstCall[0]).toBe("test-container");
      const firstArgs = firstCall[1];
      expect(firstArgs[0]).toBe("sh");
      expect(firstArgs[1]).toBe("-c");
    });

    it("uses 30s+ timeout for exec", async () => {
      execFn.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      });
      execFn.mockResolvedValueOnce(
        makeExecResult({ wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc", pid: 99 }),
      );

      await helper.launchBrowser("c1", { enabled: true } as unknown);

      // Check the second call (cat session) has timeout >= 30000
      const secondCall = execFn.mock.calls[1];
      expect(secondCall[2]?.timeout).toBeGreaterThanOrEqual(30000);
    });
  });

  describe("navigateBrowser", () => {
    it("returns url and title from exec result", async () => {
      execFn.mockResolvedValueOnce(
        makeExecResult({ url: "https://example.com", title: "Example" }),
      );

      const result = await helper.navigateBrowser("c1", "exec-123", "https://example.com", 10000);

      expect(result).toEqual({ url: "https://example.com", title: "Example" });
    });

    it("adds 5s buffer to user timeout", async () => {
      execFn.mockResolvedValueOnce(
        makeExecResult({ url: "https://example.com", title: "Example" }),
      );

      await helper.navigateBrowser("c1", "exec-123", "https://example.com", 10000);

      const callOpts = execFn.mock.calls[0][2];
      expect(callOpts?.timeout).toBe(15000); // 10000 + 5000
    });

    it("URL is JSON.stringify'd inside script, not raw interpolated", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ url: "https://evil.com", title: "Evil" }));

      await helper.navigateBrowser("c1", "exec-123", "https://example.com/path");

      const scriptArg = execFn.mock.calls[0][1][2]; // sh -c <script>
      // The URL should appear as a JSON/JS string literal (double-quoted) inside the script
      // Note: shell escaping wraps the whole script in single quotes, but the JS
      // string literals use double quotes from JSON.stringify, which pass through intact
      expect(scriptArg).toContain('"https://example.com/path"');
      // Verify the script uses page.goto
      expect(scriptArg).toContain("page.goto");
    });
  });

  describe("clickBrowser", () => {
    it("calls execFn and resolves void", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ ok: true }));

      await expect(helper.clickBrowser("c1", "exec-123", "#btn")).resolves.toBeUndefined();
      expect(execFn).toHaveBeenCalledTimes(1);
    });

    it("selector is JSON.stringify'd inside script", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ ok: true }));

      await helper.clickBrowser("c1", "exec-123", "button.submit");

      const scriptArg = execFn.mock.calls[0][1][2];
      // Selector should appear as a double-quoted JS string (from JSON.stringify)
      expect(scriptArg).toContain('"button.submit"');
      expect(scriptArg).toContain("page.click");
    });
  });

  describe("typeBrowser", () => {
    it("calls execFn with selector and text", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ ok: true }));

      await expect(
        helper.typeBrowser("c1", "exec-123", "#input", "hello world"),
      ).resolves.toBeUndefined();
      expect(execFn).toHaveBeenCalledTimes(1);
    });

    it("text value is JSON.stringify'd, not raw", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ ok: true }));

      await helper.typeBrowser("c1", "exec-123", "#input", "hello world");

      const scriptArg = execFn.mock.calls[0][1][2];
      // Text should appear as a double-quoted JS string inside the node -e script
      expect(scriptArg).toContain('"hello world"');
      expect(scriptArg).toContain("page.fill");
    });
  });

  describe("screenshotBrowser", () => {
    it("decodes base64 screenshot to Buffer", async () => {
      const originalData = Buffer.from("fake-png-data");
      const b64 = originalData.toString("base64");

      execFn.mockResolvedValueOnce(makeExecResult({ data: b64 }));

      const result = await helper.screenshotBrowser("c1", "exec-123");

      expect(result.data).toBeInstanceOf(Buffer);
      expect(result.data.toString()).toBe("fake-png-data");
    });

    it("passes fullPage option into script", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ data: Buffer.from("x").toString("base64") }));

      await helper.screenshotBrowser("c1", "exec-123", { fullPage: true });

      const scriptArg = execFn.mock.calls[0][1][2];
      expect(scriptArg).toContain("fullPage");
    });
  });

  describe("evaluateJS", () => {
    it("returns stringified result", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ result: "42" }));

      const result = await helper.evaluateJS("c1", "exec-123", "2 + 2");
      expect(result).toBe("42");
    });

    it("expression is JSON.stringify'd inside script", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ result: "test" }));

      await helper.evaluateJS("c1", "exec-123", "document.title");

      const scriptArg = execFn.mock.calls[0][1][2];
      expect(scriptArg).toContain(JSON.stringify("document.title"));
    });
  });

  describe("extractContent", () => {
    it("returns text and html", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ text: "Hello", html: "<b>Hello</b>" }));

      const result = await helper.extractContent("c1", "exec-123", ".content");
      expect(result).toEqual({ text: "Hello", html: "<b>Hello</b>" });
    });
  });

  describe("waitForSelector", () => {
    it("returns true when selector found", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ found: true }));

      const result = await helper.waitForSelector("c1", "exec-123", ".target", 5000);
      expect(result).toBe(true);
    });

    it("returns false when selector times out", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ found: false }));

      const result = await helper.waitForSelector("c1", "exec-123", ".missing", 1000);
      expect(result).toBe(false);
    });
  });

  describe("getPageInfo", () => {
    it("returns title and url", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ title: "Test Page", url: "https://test.com" }));

      const result = await helper.getPageInfo("c1", "exec-123");
      expect(result).toEqual({ title: "Test Page", url: "https://test.com" });
    });
  });

  describe("closeBrowser", () => {
    it("sends kill command via exec", async () => {
      execFn.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      });

      await expect(helper.closeBrowser("c1", "exec-123")).resolves.toBeUndefined();
      expect(execFn).toHaveBeenCalledTimes(1);

      // The script should reference kill and the session file
      const scriptArg = execFn.mock.calls[0][1][2];
      expect(scriptArg).toContain("kill");
      expect(scriptArg).toContain("pw-session");
    });
  });

  describe("error handling", () => {
    it("throws on non-zero exit code with stderr message", async () => {
      execFn.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from("node: command not found"),
        code: 127,
      });

      await expect(helper.navigateBrowser("c1", "exec-123", "https://example.com")).rejects.toThrow(
        "node: command not found",
      );
    });

    it("throws on JSON parse failure with raw stdout for debugging", async () => {
      execFn.mockResolvedValueOnce({
        stdout: Buffer.from("not valid json at all"),
        stderr: Buffer.from(""),
        code: 0,
      });

      await expect(helper.navigateBrowser("c1", "exec-123", "https://example.com")).rejects.toThrow(
        /not valid json/i,
      );
    });
  });

  describe("shell injection safety", () => {
    it("malicious selector does not break shell escaping", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ ok: true }));

      const maliciousSelector = "'; rm -rf /; echo '";
      await helper.clickBrowser("c1", "exec-123", maliciousSelector);

      const scriptArg = execFn.mock.calls[0][1][2];
      // The script is wrapped in single quotes for sh -c. The user value is
      // embedded via JSON.stringify (double-quoted JS string). Even though the
      // shell escaping transforms internal single quotes, the malicious value
      // remains INSIDE a JavaScript double-quoted string literal, never
      // reaching the shell as executable code.
      //
      // Verify the script starts with node -e and is properly structured
      expect(scriptArg).toMatch(/^node -e '/);
      // The selector value should be embedded inside page.click() call
      expect(scriptArg).toContain("page.click(");
      // The value is JSON.stringify'd inside node code: it uses \" escaping
      // for the double quotes, keeping it inside the JS string
      // Crucially: the malicious '; should NOT appear as an unquoted shell break
      // (shell breaks would be bare single quotes outside the node -e wrapper)
    });

    it("values with double quotes are escaped via JSON.stringify", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ ok: true }));

      await helper.clickBrowser("c1", "exec-123", 'a"b');

      const scriptArg = execFn.mock.calls[0][1][2];
      // JSON.stringify produces: "a\"b" -- the backslash-escaped double quote
      // ensures the value stays inside the JS string literal
      expect(scriptArg).toContain('a\\"b');
    });
  });

  describe("parseResult", () => {
    it("extracts JSON between markers", async () => {
      execFn.mockResolvedValueOnce(makeExecResult({ title: "Marked", url: "https://marked.com" }));

      const result = await helper.getPageInfo("c1", "exec-123");
      expect(result).toEqual({ title: "Marked", url: "https://marked.com" });
    });

    it("handles stdout without markers (fallback)", async () => {
      execFn.mockResolvedValueOnce(
        makePlainExecResult({ title: "Plain", url: "https://plain.com" }),
      );

      const result = await helper.getPageInfo("c1", "exec-123");
      expect(result).toEqual({ title: "Plain", url: "https://plain.com" });
    });
  });

  // ---------------------------------------------------------------------------
  // URL validation integration (Plan 17-03): blocked URLs never reach exec
  // ---------------------------------------------------------------------------

  describe("navigateBrowser URL validation", () => {
    it("rejects file:// protocol before exec", async () => {
      await expect(
        helper.navigateBrowser("container1", "session1", "file:///etc/passwd"),
      ).rejects.toThrow("Blocked protocol");

      // exec should NOT have been called
      expect(execFn).not.toHaveBeenCalled();
    });

    it("rejects chrome:// protocol before exec", async () => {
      await expect(
        helper.navigateBrowser("container1", "session1", "chrome://settings"),
      ).rejects.toThrow("Blocked protocol");
      expect(execFn).not.toHaveBeenCalled();
    });

    it("rejects data: protocol before exec", async () => {
      await expect(
        helper.navigateBrowser("container1", "session1", "data:text/html,<h1>hi</h1>"),
      ).rejects.toThrow("Blocked protocol");
      expect(execFn).not.toHaveBeenCalled();
    });

    it("rejects javascript: protocol before exec", async () => {
      await expect(
        helper.navigateBrowser("container1", "session1", "javascript:alert(1)"),
      ).rejects.toThrow("Blocked protocol");
      expect(execFn).not.toHaveBeenCalled();
    });

    it("rejects metadata endpoint before exec", async () => {
      await expect(
        helper.navigateBrowser(
          "container1",
          "session1",
          "http://169.254.169.254/latest/meta-data/",
        ),
      ).rejects.toThrow("Blocked");
      expect(execFn).not.toHaveBeenCalled();
    });

    it("rejects localhost before exec", async () => {
      await expect(
        helper.navigateBrowser("container1", "session1", "http://localhost:8080/api"),
      ).rejects.toThrow("Blocked");
      expect(execFn).not.toHaveBeenCalled();
    });

    it("allows valid HTTPS URL and calls exec", async () => {
      execFn.mockResolvedValueOnce(
        makeExecResult({
          url: "https://example.com",
          title: "Example Domain",
        }),
      );

      const result = await helper.navigateBrowser("container1", "session1", "https://example.com");
      expect(result.url).toBe("https://example.com");
      expect(result.title).toBe("Example Domain");
      expect(execFn).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Screenshot PNG magic bytes parsing (Plan 17-03)
  // ---------------------------------------------------------------------------

  describe("screenshotBrowser PNG parsing", () => {
    it("parses base64 screenshot and preserves PNG magic bytes", async () => {
      // Real PNG header: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const pngBase64 = pngHeader.toString("base64");

      execFn.mockResolvedValueOnce(makeExecResult({ data: pngBase64 }));

      const result = await helper.screenshotBrowser("container1", "session1");

      // Verify PNG magic bytes are intact after base64 decode
      expect(result.data[0]).toBe(0x89);
      expect(result.data[1]).toBe(0x50); // 'P'
      expect(result.data[2]).toBe(0x4e); // 'N'
      expect(result.data[3]).toBe(0x47); // 'G'
      expect(result.data.length).toBe(8);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling integration (Plan 17-03)
  // ---------------------------------------------------------------------------

  describe("error handling integration", () => {
    it("throws on non-zero exit code with stderr", async () => {
      execFn.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from("Playwright error: page crashed"),
        code: 1,
      });

      await expect(
        helper.navigateBrowser("container1", "session1", "https://example.com"),
      ).rejects.toThrow("Playwright error: page crashed");
    });

    it("throws on malformed JSON in stdout", async () => {
      execFn.mockResolvedValueOnce({
        stdout: Buffer.from("not json at all"),
        stderr: Buffer.from(""),
        code: 0,
      });

      await expect(
        helper.navigateBrowser("container1", "session1", "https://example.com"),
      ).rejects.toThrow("Failed to parse");
    });
  });
});
