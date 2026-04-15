/**
 * Markdown 处理工具集
 *
 * 提供围栏（fence）检测与修复、块级结构分析、原子块感知切割等能力。
 * Divided into three namespaces by responsibility:
 *  - mdFence  — 围栏相关检测与修复
 *  - mdBlock  — 块级结构检测与分隔符推断
 *  - mdAtomic — 原子块（表格 & 图表围栏块）Extract与感知切割
 */

// ============================================================================
// 围栏（fence）相关
// ============================================================================

/**
 * 剥除 AI 回复中包裹整段内容的 Markdown 围栏（```markdown ... ```）。
 *
 * 部分模型会将含表格的回复用 ```markdown 围栏包裹，导致客户端将表格当作代码块渲染。
 * This function detects and strips such outer fences, only stripping when the interior contains a table, to avoid damaging real code blocks.
 */
function stripOuterMarkdownFence(text: string): string {
  const HAS_TABLE = /^\s*\|[-:| ]+\|/m;
  return text.replace(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/gm, (fullMatch, inner: string) =>
    HAS_TABLE.test(inner) ? inner : fullMatch,
  );
}

/**
 * 检测文本是否处于未关闭的代码围栏（``` 块）内。
 *
 * 逐行扫描，遇到以 ``` 开头的行时切换 in/out 状态。奇数次切换说明存在未闭合的围栏。
 */
function hasUnclosedFence(text: string): boolean {
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
    }
  }
  return inFence;
}

/**
 * 检测文本是否处于未关闭的数学公式块（`$$...$$`）内。
 *
 * 逐行扫描，跳过代码围栏内的内容，统计 `$$` 出现次数。
 * An odd count indicates an unclosed math block.
 */
function hasUnclosedMathBlock(text: string): boolean {
  let inFence = false;
  let mathOpen = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    let idx = 0;
    while (idx < line.length - 1) {
      if (line[idx] === "$" && line[idx + 1] === "$") {
        mathOpen = !mathOpen;
        idx += 2;
      } else {
        idx++;
      }
    }
  }
  return mathOpen;
}

/**
 * 修复数学公式块内被 block-streaming 误插入的段落分隔符。
 *
 * OpenClaw 的 block-streaming 可能在 `$$...$$` 数学块内部插入 `\n\n`，
 * 导致 Markdown 解析器将其视为段落边界，破坏公式渲染。
 * 此函数将 `$$...$$` 内部的连续空行（`\n\n+`）替换为单个 `\n`。
 *
 * Note:仅处理代码围栏外的 `$$` 块，围栏内的内容保持不变。
 */
function normalizeMathBlocks(text: string): string {
  if (!text.includes("$$")) {
    return text;
  }

  const parts: string[] = [];
  let inFence = false;
  let mathOpen = false;
  let segStart = 0;

  for (let i = 0; i < text.length; i++) {
    if ((i === 0 || text[i - 1] === "\n") && text.startsWith("```", i)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    if (text[i] === "$" && i + 1 < text.length && text[i + 1] === "$") {
      if (!mathOpen) {
        mathOpen = true;
        parts.push(text.slice(segStart, i + 2));
        segStart = i + 2;
        i++;
      } else {
        const mathContent = text.slice(segStart, i);
        parts.push(mathContent.replace(/\n\n+/g, "\n"));
        parts.push("$$");
        segStart = i + 2;
        mathOpen = false;
        i++;
      }
    }
  }

  if (segStart < text.length) {
    const remaining = text.slice(segStart);
    parts.push(mathOpen ? remaining.replace(/\n\n+/g, "\n") : remaining);
  }

  return parts.join("");
}

/**
 * 将 incoming 追加到 buffer，同时剥除 block-streaming 引入的多余围栏修复标记。
 *
 * OpenClaw block-streaming 在每个切割点自动补全围栏（末尾加 `\n\`\`\``，下一块开头加
 * `\`\`\`lang\n`）。直接拼接会产生三种错误构造，本函数逐一消除：
 *
 * 1. **内部伪行**：coalescer 以空字符串拼接多个小块时，close+open 紧贴成
 *    `\n\`\`\`\`\`\`lang\n`（六反引号伪行）→ 替换为 `\n`。
 * 2. **边界情形 A**：buffer 末尾为 `\n\`\`\``（OpenClaw 关闭标记）且 incoming 以
 *    `\`\`\`lang\n` 开头 → 两侧标记均剥除，代码内容直接续接。
 * 3. **边界情形 B**：buffer 处于未闭合围栏内，incoming 又带来重开标记 → 仅剥除 incoming 的重开标记。
 */
function mergeBlockStreamingFences(buffer: string, incoming: string): string {
  const CLOSE_RE = /\n```\s*$/;
  const OPEN_RE = /^```[^\n]*\n/;

  // 情形 1：消除 incoming 内部的伪行（\n``````lang\n）
  const normalized = incoming.replace(/\n```\s*```[^\n]*\n/g, "\n");

  // 情形 2：buffer 以关闭标记结尾，incoming 以重开标记开头
  if (CLOSE_RE.test(buffer) && OPEN_RE.test(normalized)) {
    return `${buffer.replace(CLOSE_RE, "")}\n${normalized.replace(OPEN_RE, "")}`;
  }

  // 情形 3：buffer 有未闭合围栏，incoming 带来重开标记 → 剥除重开标记
  if (hasUnclosedFence(buffer) && OPEN_RE.test(normalized)) {
    return `${buffer}\n${normalized.replace(OPEN_RE, "")}`;
  }

  return `${buffer}${normalized}`;
}

// ============================================================================
// 块级结构（block）相关
// ============================================================================

/**
 * 检测文本最后一个非空行是否是 Markdown 表格行（以 | 开头且以 | 结尾）。
 *
 * 用于判断当前缓冲区是否以表格行收尾——若是，则等待下一个 deliver 块继续拼接，
 * 避免在表格中间切割导致后续消息缺少表头而展示异常。
 */
function endsWithTableRow(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return false;
  }
  const lastLine = trimmed.split("\n").at(-1) ?? "";
  const line = lastLine.trim();
  return line.startsWith("|") && line.endsWith("|");
}

/**
 * 判断文本是否以 Markdown 块级元素开头。
 *
 * 用于 block-streaming 合并时推断是否需要在两个块之间插入段落分隔符（`\n\n`）。
 * 当 incoming 文本以块级标记起始时，说明它是一个新的 Markdown 段落/结构，
 * 需要与前文之间保留段落分隔以确保渲染正确。
 *
 * 支持的块级元素：heading (`## `)、thematic break (`---`/`***`/`___`)、
 * blockquote (`> `)、fenced code block (`` ``` ``)、unordered list (`- `/`* `/`+ `)、
 * ordered list (`1. `/`1) `)、table (`|`)。
 */
function startsWithBlockElement(text: string): boolean {
  const firstLine = (text.trimStart().split("\n")[0] ?? "").trimStart();
  return (
    /^#{1,6}\s/.test(firstLine) || // heading
    firstLine.startsWith("---") || // thematic break
    firstLine.startsWith("***") ||
    firstLine.startsWith("___") ||
    firstLine.startsWith("> ") || // blockquote
    firstLine.startsWith("```") || // fenced code block
    /^[*\-+]\s/.test(firstLine) || // unordered list
    /^\d+[.)]\s/.test(firstLine) || // ordered list
    firstLine.startsWith("|") || // table
    firstLine.startsWith("$$")
  ); // display math
}

/**
 * 推断 buffer 与 incoming 块之间应补充的分隔符。
 *
 * OpenClaw 的 block-streaming 会对每个块执行 `trimEnd()` / `trimStart()`，
 * 导致原始文本中段落边界处的 `\n\n` 被丢弃。此函数根据上下文启发式地
 * 推断两块之间需要的分隔符，以还原 Markdown 语义。
 *
 * Priority (high to low):
 *  1. 围栏内 / 已有 `\n\n` → 不补（返回 `''`）
 *  2. 表格行中行切割（buffer 末行以 `|` 开头，incoming 首行以 `|` 结尾
 *     但不以 `|` 开头）→ `' '`（用空格拼回同一行）
 *  3. 连续表格行（buffer 末行 & incoming 首行均以 `|` 开头）→ `'\n'`
 *  4. incoming 以块级元素开头 → `'\n\n'`（段落分隔）
 *  5. 其他（纯文本续接）→ 不补
 */
function inferBlockSeparator(buffer: string, incoming: string): string {
  if (hasUnclosedFence(buffer)) {
    return "";
  }
  if (hasUnclosedMathBlock(buffer)) {
    return "";
  }
  if (buffer.endsWith("\n\n")) {
    return "";
  }

  const lastLine = (buffer.trimEnd().split("\n").at(-1) ?? "").trim();
  const firstLine = (incoming.trimStart().split("\n")[0] ?? "").trimStart();

  // OpenClaw 可能在 maxChars 处切断表格行，导致一行被分成两块：
  //   buffer 末行: "| GPT-4o | 88.7% | 90.2% | - |"
  //   incoming:    "- |\n| Claude 3.5 ..."
  // 检测：buffer 末行是表格行，incoming 首行以 | 结尾（同行的剩余部分）但不以 | 开头
  if (lastLine.startsWith("|") && !firstLine.startsWith("|") && firstLine.endsWith("|")) {
    return " ";
  }

  if (lastLine.startsWith("|") && firstLine.startsWith("|")) {
    return "\n";
  }

  if (startsWithBlockElement(incoming)) {
    return "\n\n";
  }

  return "";
}

// ============================================================================
// 管道表格修复（pipe-table sanitize）
// ============================================================================

/**
 * Markdown 管道表格修复器。
 *
 * OpenClaw block-streaming 可能在管道表格的任意位置（表头、分隔行、数据行、单元格中间）
 * 插入 `\n\n`（或 `\n`），导致 GFM 渲染失败。
 *
 * Strategy (region-based):
 *   阶段 0  快速路径退出：文本明显不包含表格时直接返回。
 *   阶段 1  扫描原始文本的行，找到包含 `|` 的连续行组，每组为一个候选表格区域。
 *   阶段 2  对于包含空行且含有 GFM 分隔行的区域，移除空行并根据结构信号
 *          （行是否以 `|` 开头/结尾）合并片段行，无需管道计数。
 *   阶段 3  将修复后的区域拼接回原始文本。
 */

interface PipeTableRegion {
  /** 起始行索引（含） */
  startLine: number;
  /** 结束行索引（含） */
  endLine: number;
}

/**
 * Scan raw lines, grouping consecutive pipe-containing lines as candidate table regions.
 * 管道行之间的空行保留在同一组中（它们是需要修复的 `\n\n` 产物）。
 * Non-empty lines without pipe characters end the current group.
 */
function findPipeTableRegions(lines: string[]): PipeTableRegion[] {
  const regions: PipeTableRegion[] = [];
  let groupStart = -1;
  let lastPipeLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasPipe = line.includes("|");
    const isBlank = line.trim() === "";

    if (hasPipe) {
      if (groupStart < 0) {
        groupStart = i;
      }
      lastPipeLine = i;
    } else if (isBlank) {
      // 空行 — 如果当前有分组则保留在组内
    } else {
      // 非空且无管道符 → 关闭当前分组
      if (groupStart >= 0) {
        regions.push({ startLine: groupStart, endLine: lastPipeLine });
        groupStart = -1;
        lastPipeLine = -1;
      }
    }
  }

  if (groupStart >= 0) {
    regions.push({ startLine: groupStart, endLine: lastPipeLine });
  }

  return regions;
}

/** GFM 分隔行正则：可选冒号 + 2个以上短横线 + 可选冒号，出现在两个 `|` 之间 */
const PIPE_TABLE_SEPARATOR_RE = /\|[\s]*:?-{2,}:?[\s]*(?:\|[\s]*:?-{2,}:?[\s]*)+\|/;

function findSeparatorInFlat(flat: string): boolean {
  return PIPE_TABLE_SEPARATOR_RE.test(flat);
}

/**
 * Fix a table region: remove blank lines and merge fragment lines based on structural signals.
 *
 * 规则：如果累积行以 `|` 结尾且下一行以 `|` 开头，则两者是独立行（输出累积行，开始新行）；
 * Otherwise the next line is a continuation fragment (appended to the accumulated line).
 */
function healPipeTableRegion(regionLines: string[]): string | null {
  if (!regionLines.some((l) => l.trim() === "")) {
    return null;
  }

  const flat = regionLines.join("").replace(/\n/g, "");
  if (!findSeparatorInFlat(flat)) {
    return null;
  }

  const nonBlank = regionLines.filter((l) => l.trim() !== "");
  const result: string[] = [];
  let acc = "";

  for (const line of nonBlank) {
    if (!acc) {
      acc = line;
    } else if (acc.trimEnd().endsWith("|") && line.trimStart().startsWith("|")) {
      result.push(acc);
      acc = line;
    } else {
      acc += line;
    }
  }

  if (acc) {
    result.push(acc);
  }

  return result.join("\n");
}

/**
 * 修复被 OpenClaw block-streaming 插入的多余 `\n\n` 破坏的 Markdown 管道表格。
 *
 * 识别表格区域，验证其包含 GFM 分隔行，然后移除空行并使用结构信号（行首/行尾的 `|`）
 * 重新合并片段行，确保短分隔行不会被破坏。
 *
 * 对任意文本调用均安全 — 非表格内容和格式正确的表格原样通过。
 */
function sanitizePipeTables(text: string): string {
  // 阶段 0 — 快速路径退出
  if (!text) {
    return text;
  }
  if (!text.includes("|")) {
    return text;
  }
  if (!text.includes("\n")) {
    return text;
  }

  const pipeCount = (text.match(/\|/g) || []).length;
  if (pipeCount < 3) {
    return text;
  }

  // 阶段 1 — 查找表格区域
  const lines = text.split("\n");
  const regions = findPipeTableRegions(lines);

  if (regions.length === 0) {
    return text;
  }

  // 阶段 2+3 — 修复区域并重建（倒序处理以保持索引稳定）
  for (let ri = regions.length - 1; ri >= 0; ri--) {
    const region = regions[ri];
    const regionLines = lines.slice(region.startLine, region.endLine + 1);
    const healed = healPipeTableRegion(regionLines);
    if (healed !== null) {
      const healedLines = healed.split("\n");
      lines.splice(region.startLine, region.endLine - region.startLine + 1, ...healedLines);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// 原子块（atomic）— 表格 & 图表围栏块
// ============================================================================

/** 切割后无法独立渲染、必须整体保留在同一条消息中的 Markdown 结构 */
export type AtomicBlock = { start: number; end: number; kind: "table" | "diagram-fence" };

/** 图表类围栏语言标识集合，这类围栏块切割后客户端无法渲染 */
const DIAGRAM_LANGUAGES = new Set([
  "mermaid",
  "plantuml",
  "sequence",
  "flowchart",
  "gantt",
  "classdiagram",
  "statediagram",
  "erdiagram",
  "journey",
  "gitgraph",
  "mindmap",
  "timeline",
]);

/**
 * Extract文本中所有原子块（表格块和图表围栏块）的字符偏移范围。
 *
 * 逐行扫描：
 * - 普通代码围栏（非图表语言）内的内容跳过，防止将围栏内的 `|` 误识别为表格行。
 * - 语言标识属于 DIAGRAM_LANGUAGES 的完整围栏块标记为 `diagram-fence` 原子块。
 * - 连续以 `|` 开头的行（第二行为分隔行）标记为 `table` 原子块。
 */
function extractAtomicBlocks(text: string): AtomicBlock[] {
  const blocks: AtomicBlock[] = [];
  const lines = text.split("\n");
  let offset = 0;

  let inPlainFence = false; // 当前是否处于普通代码围栏内
  let inDiagram = false; // 当前是否处于图表围栏内
  let diagramStart = 0; // 当前图表围栏的起始偏移

  let tableStart = -1; // 当前表格块起始偏移，-1 表示未在表格中
  let tableEnd = -1; // 当前表格最后一行的结束偏移
  let tableHasSep = false; // 是否已见到分隔行（第二行）
  let tableLineCount = 0; // 当前连续表格行数

  const isTableLine = (line: string) => line.trim().startsWith("|");
  const isTableSeparator = (line: string) => /^\|[\s|:-]+\|$/.test(line.trim());

  const flushTable = () => {
    // 完整表格（有分隔行）或连续 ≥2 行以 | 开头的残缺表格片段均视为原子块，
    // 防止 chunkMarkdownText 在残缺表格行间切割，破坏后续完整表格的渲染。
    if (tableStart !== -1 && tableEnd !== -1 && (tableHasSep || tableLineCount >= 2)) {
      blocks.push({ start: tableStart, end: tableEnd, kind: "table" });
    }
    tableStart = -1;
    tableEnd = -1;
    tableHasSep = false;
    tableLineCount = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 最后一行若无结尾 \n，偏移按实际长度计算
    const lineEnd = offset + line.length + (i < lines.length - 1 ? 1 : 0);

    if (inPlainFence || inDiagram) {
      if (line.startsWith("```")) {
        if (inDiagram) {
          blocks.push({ start: diagramStart, end: lineEnd, kind: "diagram-fence" });
          inDiagram = false;
        } else {
          inPlainFence = false;
        }
      }
      offset = lineEnd;
      continue;
    }

    if (line.startsWith("```")) {
      flushTable();
      const lang = line.slice(3).trim().toLowerCase();
      if (lang && DIAGRAM_LANGUAGES.has(lang)) {
        inDiagram = true;
        diagramStart = offset;
      } else {
        inPlainFence = true;
      }
      offset = lineEnd;
      continue;
    }

    if (isTableLine(line)) {
      if (tableStart === -1) {
        tableStart = offset;
        tableLineCount = 1;
        tableHasSep = false;
      } else {
        tableLineCount++;
        if (!tableHasSep && tableLineCount === 2 && isTableSeparator(line)) {
          tableHasSep = true;
        }
      }
      tableEnd = lineEnd;
    } else {
      flushTable();
    }

    offset = lineEnd;
  }

  flushTable();
  return blocks.toSorted((a, b) => a.start - b.start);
}

/**
 * 原子块感知的 Markdown 文本切割函数。
 *
 * 先调用 `chunkFn` 做 fence-aware 粗切割，再检测各切割边界是否落在原子块（表格 / 图表围栏块）内：
 * - 若落在原子块内，优先将切割点前移到 `block.start`（整块推入下一条消息）；
 * - 若无法前移（块在当前 chunk 起始处），则后移到 `block.end`（整块纳入当前 chunk，允许超出 maxChars）。
 * - 若整段文本就是单个超大原子块，直接返回 `[text]`（单条超大消息，优雅降级）。
 */
function chunkMarkdownTextAtomicAware(
  text: string,
  maxChars: number,
  chunkFn: (text: string, max: number) => string[],
): string[] {
  const rawChunks = chunkFn(text, maxChars);
  if (rawChunks.length <= 1) {
    return rawChunks;
  }

  const atomicBlocks = extractAtomicBlocks(text);
  if (atomicBlocks.length === 0) {
    return rawChunks;
  }

  // 从 rawChunks 重建切割边界（累计偏移，不含末尾）
  const splitIndices: number[] = [];
  let cumLen = 0;
  for (let i = 0; i < rawChunks.length - 1; i++) {
    cumLen += rawChunks[i].length;
    splitIndices.push(cumLen);
  }

  // 调整每个切割点，确保不落在原子块内部
  const adjustedIndices: number[] = [];
  let chunkWindowStart = 0;

  for (const idx of splitIndices) {
    const hit = atomicBlocks.find((b) => b.start < idx && idx < b.end);
    if (!hit) {
      adjustedIndices.push(idx);
      chunkWindowStart = idx;
      continue;
    }

    if (hit.start > chunkWindowStart) {
      // 前移：整块推入下一条消息
      adjustedIndices.push(hit.start);
      chunkWindowStart = hit.start;
    } else {
      // 无法前移：整块纳入当前消息（允许超出 maxChars，优雅降级）
      adjustedIndices.push(hit.end);
      chunkWindowStart = hit.end;
    }
  }

  // 按调整后的边界重切文本
  const result: string[] = [];
  let prev = 0;
  for (const idx of adjustedIndices) {
    if (idx > prev) {
      result.push(text.slice(prev, idx));
    }
    prev = idx;
  }
  if (prev < text.length) {
    result.push(text.slice(prev));
  }

  return result.filter((c) => c.length > 0);
}

// ============================================================================
// 结构化命名空间导出
// ============================================================================

/** 围栏（fence）相关检测与修复 */
export const mdFence = {
  /** 剥除外层 ```markdown 围栏 */
  stripOuter: stripOuterMarkdownFence,
  /** 检测是否存在未闭合的围栏 */
  hasUnclosed: hasUnclosedFence,
  /** 检测是否存在未闭合的数学公式块 */
  hasUnclosedMath: hasUnclosedMathBlock,
  /** 合并 block-streaming 引入的多余围栏标记 */
  mergeBlockStreaming: mergeBlockStreamingFences,
} as const;

/** 块级结构检测与分隔符推断 */
export const mdBlock = {
  /** 判断文本是否以块级元素开头 */
  startsWithBlockElement,
  /** 检测文本是否以表格行结尾 */
  endsWithTableRow,
  /** 推断两个 block-streaming 块之间的分隔符 */
  inferSeparator: inferBlockSeparator,
} as const;

/** 原子块（表格 & 图表围栏块）感知切割 */
export const mdAtomic = {
  /** Extract文本中所有原子块的偏移范围 */
  extract: extractAtomicBlocks,
  /** 原子块感知的文本切割 */
  chunkAware: chunkMarkdownTextAtomicAware,
  /** 图表类围栏语言标识集合 */
  DIAGRAM_LANGUAGES,
} as const;

/** 管道表格修复 */
export const mdTable = {
  /** 修复被 block-streaming 破坏的管道表格 */
  sanitize: sanitizePipeTables,
} as const;

/** 数学公式块修复 */
export const mdMath = {
  /** 检测是否存在未闭合的数学公式块 */
  hasUnclosed: hasUnclosedMathBlock,
  /** 修复数学公式块内被 block-streaming 误插入的段落分隔符 */
  normalize: normalizeMathBlocks,
} as const;
