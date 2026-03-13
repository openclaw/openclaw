import { describe, it, expect } from "vitest";
import { validateBrowserURL } from "./browser-security.js";

describe("validateBrowserURL", () => {
  // -------------------------------------------------------------------------
  // Blocked protocols
  // -------------------------------------------------------------------------

  it("rejects file:// protocol", () => {
    expect(() => validateBrowserURL("file:///etc/passwd")).toThrow("Blocked protocol");
  });

  it("rejects chrome:// protocol", () => {
    expect(() => validateBrowserURL("chrome://settings")).toThrow("Blocked protocol");
  });

  it("rejects chrome-extension:// protocol", () => {
    expect(() => validateBrowserURL("chrome-extension://abc/popup.html")).toThrow(
      "Blocked protocol",
    );
  });

  it("rejects data: protocol", () => {
    expect(() => validateBrowserURL("data:text/html,<h1>hi</h1>")).toThrow("Blocked protocol");
  });

  it("rejects javascript: protocol", () => {
    expect(() => validateBrowserURL("javascript:alert(1)")).toThrow("Blocked protocol");
  });

  it("rejects vbscript: protocol", () => {
    expect(() => validateBrowserURL("vbscript:MsgBox(1)")).toThrow("Blocked protocol");
  });

  // -------------------------------------------------------------------------
  // Metadata endpoints
  // -------------------------------------------------------------------------

  it("rejects AWS/GCP metadata endpoint", () => {
    expect(() => validateBrowserURL("http://169.254.169.254/latest/")).toThrow("Blocked");
  });

  // -------------------------------------------------------------------------
  // Loopback and private IPs
  // -------------------------------------------------------------------------

  it("rejects loopback 127.0.0.1", () => {
    expect(() => validateBrowserURL("http://127.0.0.1/")).toThrow("Blocked");
  });

  it("rejects localhost", () => {
    expect(() => validateBrowserURL("http://localhost/")).toThrow("Blocked");
  });

  it("rejects 10.x.x.x private range", () => {
    expect(() => validateBrowserURL("http://10.0.0.1/")).toThrow("Blocked");
  });

  it("rejects 172.16.x.x private range", () => {
    expect(() => validateBrowserURL("http://172.16.0.1/")).toThrow("Blocked");
  });

  it("rejects 192.168.x.x private range", () => {
    expect(() => validateBrowserURL("http://192.168.1.1/")).toThrow("Blocked");
  });

  // -------------------------------------------------------------------------
  // Valid public URLs
  // -------------------------------------------------------------------------

  it("allows https://example.com", () => {
    expect(() => validateBrowserURL("https://example.com")).not.toThrow();
  });

  it("allows http://93.184.216.34/page", () => {
    expect(() => validateBrowserURL("http://93.184.216.34/page")).not.toThrow();
  });

  it("allows https://google.com", () => {
    expect(() => validateBrowserURL("https://google.com")).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Empty and malformed URLs
  // -------------------------------------------------------------------------

  it("rejects empty string", () => {
    expect(() => validateBrowserURL("")).toThrow("Invalid URL");
  });

  it("rejects malformed URL with no protocol", () => {
    expect(() => validateBrowserURL("not-a-url")).toThrow();
  });
});
