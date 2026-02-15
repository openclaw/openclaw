import type { OpenClawConfig } from "openclaw/plugin-sdk";

// 默认给一个相对“够用”的上限（80MB），避免视频/较大文件频繁触发失败。
// 仍保留上限以防止恶意大文件把进程内存打爆（下载实现会读入内存再保存）。
export const DEFAULT_WECOM_MEDIA_MAX_BYTES = 80 * 1024 * 1024;

export function resolveWecomMediaMaxBytes(cfg: OpenClawConfig): number {
  const raw = (cfg.channels?.wecom as any)?.media?.maxBytes;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return DEFAULT_WECOM_MEDIA_MAX_BYTES;
}
