import { getZaloUserInfo } from "./zalo-js.js";
async function probeZalouser(profile, timeoutMs) {
  try {
    const user = timeoutMs ? await Promise.race([
      getZaloUserInfo(profile),
      new Promise(
        (resolve) => setTimeout(() => resolve(null), Math.max(timeoutMs, 1e3))
      )
    ]) : await getZaloUserInfo(profile);
    if (!user) {
      return { ok: false, error: "Not authenticated" };
    }
    return { ok: true, user };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
export {
  probeZalouser
};
