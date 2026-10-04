import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import "../../test-support/browser-security.mock.js";
import {
  installAgentContractHooks,
  startServerAndBase,
} from "../server.agent-contract.test-harness.js";
import {
  getChromeMcpMocks,
  getPwMocks,
  setBrowserControlServerProfiles,
  setBrowserControlServerSsrFPolicy,
  setBrowserControlServerTabUrl,
} from "../server.control-server.test-harness.js";
import { getBrowserTestFetch } from "../test-support/fetch.js";

describe("browser page text route", () => {
  installAgentContractHooks();
  const chromeMcpMocks = getChromeMcpMocks();
  const pwMocks = getPwMocks();
  const pageText = expectDefined(pwMocks.getPageTextViaPlaywright, "page text mock");

  it("returns page text, truncation, and the resolved tab through the control service", async () => {
    pageText.mockResolvedValueOnce({ text: "Selected text", truncated: true });
    const base = await startServerAndBase();
    const response = await getBrowserTestFetch()(
      `${base}/text?targetId=abcd1234&selector=article&maxChars=13`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      targetId: "abcd1234",
      url: "https://example.com",
      text: "Selected text",
      truncated: true,
    });
    expect(pageText).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "abcd1234",
        selector: "article",
        maxChars: 13,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects invalid maxChars before extraction", async () => {
    const base = await startServerAndBase();
    const response = await getBrowserTestFetch()(`${base}/text?maxChars=1e3`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "maxChars must be a positive integer." });
    expect(pageText).not.toHaveBeenCalled();
  });

  it("rejects disallowed current tab URLs before reading page text", async () => {
    setBrowserControlServerSsrFPolicy({ allowPrivateNetwork: false });
    setBrowserControlServerTabUrl("http://127.0.0.1:8080/admin");
    const base = await startServerAndBase();
    const response = await getBrowserTestFetch()(`${base}/text?targetId=abcd1234`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "browser navigation blocked by policy",
      reason: "navigation_blocked",
    });
    expect(pageText).not.toHaveBeenCalled();
  });

  it("extracts page text through Chrome MCP for existing-session profiles", async () => {
    setBrowserControlServerProfiles(
      { user: { driver: "existing-session", color: "#FF4500" } },
      "user",
    );
    const document = expectDefined(chromeMcpMocks.withChromeMcpDocument, "Chrome MCP document");
    const evaluate = expectDefined(chromeMcpMocks.evaluateChromeMcpScript, "Chrome MCP evaluate");
    evaluate.mockResolvedValueOnce({
      url: "https://example.com",
      text: "Existing session text",
      truncated: false,
    });
    const base = await startServerAndBase();
    const response = await getBrowserTestFetch()(
      `${base}/text?profile=user&selector=article&maxChars=21`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      targetId: "7",
      url: "https://example.com",
      text: "Existing session text",
      truncated: false,
    });
    expect(document).toHaveBeenCalledWith(
      expect.objectContaining({ profileName: "user", targetId: "7" }),
      expect.any(Function),
    );
    expect(evaluate).toHaveBeenCalledWith(expect.stringContaining("boundDocument"));
  });

  it("rejects text from a forbidden evaluated document when the tab listing is stale", async () => {
    setBrowserControlServerProfiles(
      { user: { driver: "existing-session", color: "#FF4500" } },
      "user",
    );
    setBrowserControlServerSsrFPolicy({
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["example.com"],
    });
    setBrowserControlServerTabUrl("https://example.com");
    const evaluate = expectDefined(chromeMcpMocks.evaluateChromeMcpScript, "Chrome MCP evaluate");
    evaluate.mockResolvedValueOnce({
      url: "http://127.0.0.1:8080/forbidden",
      text: "must not be returned",
      truncated: false,
    });
    const base = await startServerAndBase();
    const response = await getBrowserTestFetch()(`${base}/text?profile=user`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "browser navigation blocked by policy",
      reason: "navigation_blocked",
    });
    expect(evaluate).toHaveBeenCalledWith(expect.stringContaining("boundDocument"));
  });
});
