/**
 * Minimal platform detection, mirroring InfringementController::detectPlatform
 * in leading-v2.0. This is only a provisional label for the DB row — the Java
 * 研判 worker re-detects the real platform when it crawls the link.
 *
 * Case-insensitive substring match (PHP uses stripos / mb_stripos).
 */
const DOMAIN_MAP: ReadonlyArray<readonly [string, string]> = [
  ["mp.weixin.qq.com", "微信公众号"],
  ["weibo.com", "微博"],
  ["toutiao.com", "今日头条"],
  ["douyin.com", "抖音"],
  ["xiaohongshu.com", "小红书"],
  ["zhihu.com", "知乎"],
  ["baijiahao.baidu", "百家号"],
];

export function detectPlatform(url: string): string {
  const raw = url ?? "";
  // 微信视频号 has no public URL; reporters type "视频号：账号名 ..." free text.
  if (raw.includes("视频号") || /channels\.weixin\.qq\.com/i.test(raw)) {
    return "微信视频号";
  }
  const lower = raw.toLowerCase();
  for (const [domain, name] of DOMAIN_MAP) {
    if (lower.includes(domain)) {
      return name;
    }
  }
  return "";
}
