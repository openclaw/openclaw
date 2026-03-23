/**
 * 富媒体标签预处理与纠错
 *
 * 小模型常见的标签拼写错误及变体，在正则匹配前统一修正为标准格式。
 */

import { expandTilde } from "./platform.js";

// 标准标签名（qqmedia = 统一标签，系统根据文件扩展名自动路由）
const VALID_TAGS = ["qqimg", "qqvoice", "qqvideo", "qqfile", "qqmedia"] as const;

// 开头标签别名映射（key 全部小写）
const TAG_ALIASES: Record<string, (typeof VALID_TAGS)[number]> = {
  // ---- qqimg 变体 ----
  qq_img: "qqimg",
  qqimage: "qqimg",
  qq_image: "qqimg",
  qqpic: "qqimg",
  qq_pic: "qqimg",
  qqpicture: "qqimg",
  qq_picture: "qqimg",
  qqphoto: "qqimg",
  qq_photo: "qqimg",
  img: "qqimg",
  image: "qqimg",
  pic: "qqimg",
  picture: "qqimg",
  photo: "qqimg",
  // ---- qqvoice 变体 ----
  qq_voice: "qqvoice",
  qqaudio: "qqvoice",
  qq_audio: "qqvoice",
  voice: "qqvoice",
  audio: "qqvoice",
  // ---- qqvideo 变体 ----
  qq_video: "qqvideo",
  video: "qqvideo",
  // ---- qqfile 变体 ----
  qq_file: "qqfile",
  qqdoc: "qqfile",
  qq_doc: "qqfile",
  file: "qqfile",
  doc: "qqfile",
  document: "qqfile",
  // ---- qqmedia 变体（统一标签，根据扩展名自动路由） ----
  qq_media: "qqmedia",
  media: "qqmedia",
  attachment: "qqmedia",
  attach: "qqmedia",
  qqattachment: "qqmedia",
  qq_attachment: "qqmedia",
  qqsend: "qqmedia",
  qq_send: "qqmedia",
  send: "qqmedia",
};

// 构建所有可识别的标签名列表（标准名 + 别名）
const ALL_TAG_NAMES = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)];
// 按长度降序排列，优先匹配更长的名称（避免 "img" 抢先匹配 "qqimg" 的子串）
ALL_TAG_NAMES.sort((a, b) => b.length - a.length);

const TAG_NAME_PATTERN = ALL_TAG_NAMES.join("|");

/**
 * 自闭合属性语法的正则：
 *   <qqmedia file="/path/to/file.png" />
 *   <qqimg src="/path" />
 *   <image file="..." />
 *   <qqmedia type="file" path="/path/to/file.zip" />   ← 多属性
 * 支持 file= / src= / path= / url= 属性名，引号可选
 * 也支持前面有其他属性（如 type="file"）的多属性写法
 */
const SELF_CLOSING_TAG_REGEX = new RegExp(
  "`?" +
    "[<＜<]\\s*(" +
    TAG_NAME_PATTERN +
    ")" +
    // 允许前面有任意其他属性（如 type="file"），非贪婪跳过
    "(?:\\s+(?!file|src|path|url)[a-z_-]+\\s*=\\s*[\"']?[^\"'/>＞>]*?[\"']?)*" +
    "\\s+(?:file|src|path|url)\\s*=\\s*" +
    "[\"']?" +
    "([^\"'/>＞>]+?)" +
    "[\"']?" +
    // 允许后面还有其他属性
    "(?:\\s+[a-z_-]+\\s*=\\s*[\"']?[^\"'/>＞>]*?[\"']?)*" +
    "\\s*/?" +
    "\\s*[>＞>]" +
    "`?",
  "gi",
);

/**
 * 构建一个宽容的正则，能匹配各种畸形标签写法：
 *
 * 常见错误模式：
 *  1. 标签名拼错：<qq_img>, <qqimage>, <image>, <img>, <pic> ...
 *  2. 标签内多余空格：<qqimg >, < qqimg>, <qqimg >
 *  3. 闭合标签不匹配：<qqimg>url</qqvoice>, <qqimg>url</img>
 *  4. 闭合标签缺失斜杠：<qqimg>url<qqimg> (用开头标签代替闭合标签)
 *  5. 闭合标签缺失尖括号：<qqimg>url/qqimg>
 *  6. 中文尖括号：＜qqimg＞url＜/qqimg＞ 或 <qqimg>url</qqimg>
 *  7. 多余引号包裹路径：<qqimg>"path"</qqimg>
 *  8. Markdown 代码块包裹：`<qqimg>path</qqimg>`
 *  9. 自闭合属性语法：<qqmedia file="/path" /> (由 SELF_CLOSING_TAG_REGEX 处理)
 */
const FUZZY_MEDIA_TAG_REGEX = new RegExp(
  // 可选 Markdown 行内代码反引号
  "`?" +
    // 开头标签：允许中文/英文尖括号，标签名前后可有空格
    "[<＜<]\\s*(" +
    TAG_NAME_PATTERN +
    ")\\s*[>＞>]" +
    // 内容：非贪婪匹配，允许引号包裹
    "[\"']?\\s*" +
    "([^<＜<＞>\"'`]+?)" +
    "\\s*[\"']?" +
    // 闭合标签：允许各种不规范写法
    "[<＜<]\\s*/?\\s*(?:" +
    TAG_NAME_PATTERN +
    ")\\s*[>＞>]" +
    // 可选结尾反引号
    "`?",
  "gi",
);

/**
 * 将标签名映射为标准名称
 */
function resolveTagName(raw: string): (typeof VALID_TAGS)[number] {
  const lower = raw.toLowerCase();
  if ((VALID_TAGS as readonly string[]).includes(lower)) {
    return lower as (typeof VALID_TAGS)[number];
  }
  return TAG_ALIASES[lower] ?? "qqimg";
}

/**
 * 预清理：将富媒体标签内部的换行/回车/制表符压缩为单个空格。
 *
 * 部分模型会在标签内部插入 \n \r \t 等空白字符，例如：
 *   <qqimg>\n  /path/to/file.png\n</qqimg>
 *   <qqimg>/path/to/\nfile.png</qqimg>
 *
 * 此正则匹配从开标签到闭标签之间的内容（允许跨行），
 * 将内部所有 [\r\n\t] 替换为空格，然后压缩连续空格。
 */
const MULTILINE_TAG_CLEANUP = new RegExp(
  "([<＜<]\\s*(?:" +
    TAG_NAME_PATTERN +
    ")\\s*[>＞>])" +
    "([\\s\\S]*?)" +
    "([<＜<]\\s*/?\\s*(?:" +
    TAG_NAME_PATTERN +
    ")\\s*[>＞>])",
  "gi",
);

/**
 * 预处理 LLM 输出文本，将各种畸形/错误的富媒体标签修正为标准格式。
 *
 * 标准格式：<qqimg>/path/to/file</qqimg>
 *
 * @param text LLM 原始输出
 * @returns 修正后的文本（如果没有匹配到任何标签则原样返回）
 */
export function normalizeMediaTags(text: string): string {
  // 第 0 步：将自闭合属性语法转换为标准包裹语法
  // <qqmedia file="/path/to/file.png" /> → <qqmedia>/path/to/file.png</qqmedia>
  let cleaned = text.replace(SELF_CLOSING_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) return _match;
    const expanded = expandTilde(trimmed);
    return `<${tag}>${expanded}</${tag}>`;
  });

  // 第 1 步：将标签内部的换行/回车/制表符压缩为空格
  cleaned = cleaned.replace(
    MULTILINE_TAG_CLEANUP,
    (_m, open: string, body: string, close: string) => {
      const flat = body.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
      return open + flat + close;
    },
  );

  // 第 2 步：将各种畸形标签统一为标准格式
  return cleaned.replace(FUZZY_MEDIA_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) return _match; // 空内容不处理
    // 展开波浪线路径：~/Desktop/file.png → /Users/xxx/Desktop/file.png
    const expanded = expandTilde(trimmed);
    return `<${tag}>${expanded}</${tag}>`;
  });
}
