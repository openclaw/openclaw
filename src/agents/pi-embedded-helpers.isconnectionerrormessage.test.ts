import { describe, expect, it } from "vitest";
import { isConnectionErrorMessage } from "./pi-embedded-helpers.js";

describe("isConnectionErrorMessage", () => {
  it("matches the OpenAI SDK default 'Connection error.' message", () => {
    expect(isConnectionErrorMessage("Connection error.")).toBe(true);
    expect(isConnectionErrorMessage("Connection error")).toBe(true);
    expect(isConnectionErrorMessage("connection error.")).toBe(true);
    expect(isConnectionErrorMessage("CONNECTION ERROR")).toBe(true);
  });

  it("matches ECONNREFUSED errors", () => {
    expect(isConnectionErrorMessage("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
    expect(isConnectionErrorMessage("ECONNREFUSED")).toBe(true);
  });

  it("matches ECONNRESET errors", () => {
    expect(isConnectionErrorMessage("ECONNRESET")).toBe(true);
    expect(isConnectionErrorMessage("read ECONNRESET")).toBe(true);
  });

  it("matches ECONNABORTED errors", () => {
    expect(isConnectionErrorMessage("ECONNABORTED")).toBe(true);
  });

  it("matches fetch failed errors", () => {
    expect(isConnectionErrorMessage("fetch failed")).toBe(true);
    expect(isConnectionErrorMessage("TypeError: fetch failed")).toBe(true);
  });

  it("matches socket hang up", () => {
    expect(isConnectionErrorMessage("socket hang up")).toBe(true);
  });

  it("matches network error variants", () => {
    expect(isConnectionErrorMessage("network error")).toBe(true);
    expect(isConnectionErrorMessage("network failure")).toBe(true);
    expect(isConnectionErrorMessage("network unavailable")).toBe(true);
  });

  it("matches APIConnectionError class name", () => {
    expect(isConnectionErrorMessage("APIConnectionError: Connection error.")).toBe(true);
  });

  it("matches DNS resolution failures", () => {
    expect(isConnectionErrorMessage("getaddrinfo EAI_AGAIN api.example.com")).toBe(true);
    expect(isConnectionErrorMessage("getaddrinfo ENOTFOUND api.example.com")).toBe(true);
  });

  it("matches unreachable host", () => {
    expect(isConnectionErrorMessage("connect EHOSTUNREACH 10.0.0.1:443")).toBe(true);
  });

  it("matches 'unable to connect' variants", () => {
    expect(isConnectionErrorMessage("unable to connect to the server")).toBe(true);
    expect(isConnectionErrorMessage("Unable to connect")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isConnectionErrorMessage("invalid api key")).toBe(false);
    expect(isConnectionErrorMessage("rate limit exceeded")).toBe(false);
    expect(isConnectionErrorMessage("context length exceeded")).toBe(false);
    expect(isConnectionErrorMessage("overloaded")).toBe(false);
    expect(isConnectionErrorMessage("")).toBe(false);
    expect(isConnectionErrorMessage("some random error")).toBe(false);
  });
});
