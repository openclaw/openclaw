import type { OpenClawRuntime } from "openclaw/plugin-sdk/kakao";

let kakaoRuntime: OpenClawRuntime | null = null;

export function setKakaoRuntime(runtime: OpenClawRuntime): void {
  kakaoRuntime = runtime;
}

export function getKakaoRuntime(): OpenClawRuntime {
  if (!kakaoRuntime) {
    throw new Error("KakaoTalk runtime not initialized");
  }
  return kakaoRuntime;
}
