import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCrmUrl, CrmApiError, crmRequest } from "./client.js";
import type { CrmConfig } from "./config.js";

const CONFIG: CrmConfig = {
  baseUrl: "http://crm.test:3001",
  apiKey: "crm-secret",
  timeoutSeconds: 5,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("crm client", () => {
  it("builds REST bridge URLs and drops empty query values", () => {
    const url = buildCrmUrl(CONFIG, "/search", {
      q: "acme",
      page: 2,
      empty: "",
      missing: undefined,
    });

    expect(url.toString()).toBe("http://crm.test:3001/rest/search?q=acme&page=2");
  });

  it("sends the API key and JSON body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "contact-1" }));

    await expect(
      crmRequest(CONFIG, {
        method: "POST",
        path: "/contacts",
        body: { firstName: "Ada" },
      }),
    ).resolves.toEqual({ id: "contact-1" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://crm.test:3001/rest/contacts");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      accept: "application/json",
      "x-api-key": "crm-secret",
      "content-type": "application/json",
    });
    expect(init?.body).toBe(JSON.stringify({ firstName: "Ada" }));
  });

  it("reports auth failures with the key setup path", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "Invalid API key" }, { status: 401 }),
    );

    await expect(crmRequest(CONFIG, { method: "GET", path: "/search" })).rejects.toEqual(
      expect.objectContaining({
        name: "CrmApiError",
        status: 401,
        message: expect.stringContaining("Settings → API keys"),
      }),
    );
  });

  it("keeps the CRM error payload on the typed error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "No company with id missing." }, { status: 404 }),
    );

    const error = await crmRequest(CONFIG, { method: "GET", path: "/companies/missing" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CrmApiError);
    expect((error as CrmApiError).status).toBe(404);
    expect((error as CrmApiError).payload).toEqual({
      message: "No company with id missing.",
    });
  });

  it("does not call the network after the caller aborts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));

    await expect(
      crmRequest(CONFIG, {
        method: "GET",
        path: "/search",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled by caller");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
