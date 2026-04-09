import { afterEach, describe, expect, it } from "vitest";
import { collectProviderApiKeys } from "./live-auth-keys.js";

const ORIGINAL_MODELSTUDIO_API_KEY = process.env.MODELSTUDIO_API_KEY;
const ORIGINAL_XAI_API_KEY = process.env.XAI_API_KEY;

describe("collectProviderApiKeys", () => {
  afterEach(() => {
    if (ORIGINAL_MODELSTUDIO_API_KEY === undefined) {
      delete process.env.MODELSTUDIO_API_KEY;
    } else {
      process.env.MODELSTUDIO_API_KEY = ORIGINAL_MODELSTUDIO_API_KEY;
    }
    if (ORIGINAL_XAI_API_KEY === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = ORIGINAL_XAI_API_KEY;
    }
  });

  it("honors manifest-declared provider auth env vars for nonstandard provider ids", () => {
    process.env.MODELSTUDIO_API_KEY = "modelstudio-live-key";

    expect(collectProviderApiKeys("alibaba")).toContain("modelstudio-live-key");
  });

  it("dedupes manifest env vars against direct provider env naming", () => {
    process.env.XAI_API_KEY = "xai-live-key";

    expect(collectProviderApiKeys("xai")).toEqual(["xai-live-key"]);
  });
});
