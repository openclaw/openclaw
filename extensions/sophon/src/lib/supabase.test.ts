import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { __resetSupabaseForTests, getSupabaseClient, initSession } from "./supabase.js";

describe("sophon supabase auth", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    __resetSupabaseForTests();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SOPHON_SUPABASE_URL;
    delete process.env.SOPHON_SUPABASE_KEY;
    delete process.env.SOPHON_REFRESH_TOKEN;
    delete process.env.SOPHON_USER_TOKEN;
    createClientMock.mockReset();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    __resetSupabaseForTests();
  });

  it("throws when url/key env vars are missing", () => {
    expect(() => getSupabaseClient()).toThrow(/SOPHON_SUPABASE_URL|SOPHON_SUPABASE_KEY/);
  });

  it("refreshes a session when SOPHON_REFRESH_TOKEN is set", async () => {
    const refreshSession = vi.fn().mockResolvedValue({ data: {}, error: null });
    createClientMock.mockReturnValue({ auth: { refreshSession } });

    process.env.SOPHON_SUPABASE_URL = "https://example.supabase.co";
    process.env.SOPHON_SUPABASE_KEY = "anon";
    process.env.SOPHON_REFRESH_TOKEN = "refresh-token";

    const client = getSupabaseClient();
    await initSession(client);
    await initSession(client);

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).toHaveBeenCalledWith({ refresh_token: "refresh-token" });
  });

  it("throws when refresh fails and no access token fallback exists", async () => {
    const refreshSession = vi.fn().mockResolvedValue({
      data: { session: null },
      error: { message: "bad refresh" },
    });
    createClientMock.mockReturnValue({ auth: { refreshSession } });

    process.env.SOPHON_SUPABASE_URL = "https://example.supabase.co";
    process.env.SOPHON_SUPABASE_KEY = "anon";
    process.env.SOPHON_REFRESH_TOKEN = "bad-refresh-token";

    const client = getSupabaseClient();
    await expect(initSession(client)).rejects.toThrow(/failed to refresh session/i);
  });

  it("accepts SOPHON_USER_TOKEN-only mode", async () => {
    const refreshSession = vi.fn();
    createClientMock.mockReturnValue({ auth: { refreshSession } });

    process.env.SOPHON_SUPABASE_URL = "https://example.supabase.co";
    process.env.SOPHON_SUPABASE_KEY = "anon";
    process.env.SOPHON_USER_TOKEN = "user-token";

    const client = getSupabaseClient();
    await expect(initSession(client)).resolves.toBeUndefined();
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
