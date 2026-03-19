/**
 * Strategy package validation for Findoo Backtest Agent (FEP v2.0).
 * Validates fep.yaml structure, strategy script safety, and required fields.
 * @module openfinclaw/validate
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FepV2Style, FepV2Timeframe } from "./types.js";

/** FEP 版本常量 */
const FEP_VERSION = "2.0";

/** Symbol 格式正则 */
const SYMBOL_PATTERNS = {
  crypto: /^[A-Z][A-Z0-9]{1,9}\/[A-Z][A-Z0-9]{1,9}$/,
  aShare: /^\d{6}\.(SZ|SH)$/,
  etf: /^5\d{5}\.SH$/,
  index: /^000\d{3}\.SH$/,
  hkStock: /^\d{5}\.HK$/,
  usStock: /^[A-Z][A-Z0-9]{0,4}$/,
  futures: /^[A-Z]+\d{4}\.[A-Z]+$/,
};

/** 策略风格枚举 */
const VALID_STYLES: FepV2Style[] = [
  "trend",
  "mean-reversion",
  "momentum",
  "value",
  "growth",
  "breakout",
  "rotation",
  "hybrid",
];

/** K线周期枚举 */
const VALID_TIMEFRAMES: FepV2Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];

/** 可见性枚举 */
const VALID_VISIBILITY = ["public", "private", "unlisted"];

/** 许可证枚举 */
const VALID_LICENSES = ["MIT", "CC-BY-4.0", "proprietary"];

/** 禁止的 Python 导入模式（v2.0 扩展黑名单） */
const FORBIDDEN_IMPORT_PATTERNS = [
  /\bimport\s+os\b/,
  /\bimport\s+sys\b/,
  /\bimport\s+subprocess\b/,
  /\bimport\s+socket\b/,
  /\bimport\s+shutil\b/,
  /\bimport\s+ctypes\b/,
  /\bimport\s+importlib\b/,
  /\bimport\s+signal\b/,
  /\bimport\s+threading\b/,
  /\bimport\s+multiprocessing\b/,
  /\bimport\s+pathlib\b/,
  /\bimport\s+tempfile\b/,
  /\bimport\s+requests\b/,
  /\bimport\s+urllib\b/,
  /\bimport\s+http\b/,
  /\bimport\s+ftplib\b/,
  /\bimport\s+smtplib\b/,
  /\bimport\s+xmlrpc\b/,
  /\bimport\s+pickle\b/,
  /\bimport\s+shelve\b/,
  /\bimport\s+marshal\b/,
  /\bimport\s+concurrent\b/,
  /\bimport\s+asyncio\b/,
  /\bimport\s+io\b/,
  /\bfrom\s+os\b/,
  /\bfrom\s+sys\b/,
  /\bfrom\s+subprocess\b/,
  /\bfrom\s+socket\b/,
  /\bfrom\s+shutil\b/,
  /\bfrom\s+ctypes\b/,
  /\bfrom\s+importlib\b/,
  /\bfrom\s+signal\b/,
  /\bfrom\s+threading\b/,
  /\bfrom\s+multiprocessing\b/,
  /\bfrom\s+pathlib\b/,
  /\bfrom\s+tempfile\b/,
  /\bfrom\s+requests\b/,
  /\bfrom\s+urllib\b/,
  /\bfrom\s+http\b/,
  /\bfrom\s+ftplib\b/,
  /\bfrom\s+smtplib\b/,
  /\bfrom\s+xmlrpc\b/,
  /\bfrom\s+pickle\b/,
  /\bfrom\s+shelve\b/,
  /\bfrom\s+marshal\b/,
  /\bfrom\s+concurrent\b/,
  /\bfrom\s+asyncio\b/,
  /\bfrom\s+io\b/,
];

/** 禁止的 Python 函数调用模式 */
const FORBIDDEN_CALL_PATTERNS = [
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /\bcompile\s*\(/,
  /\bopen\s*\(/,
  /\b__import__\s*\(/,
  /\bgetattr\s*\(/,
  /\bsetattr\s*\(/,
  /\bdelattr\s*\(/,
  /\bvars\s*\(/,
  /\bdir\s*\(/,
  /\bbreakpoint\s*\(/,
  /\bexit\s*\(/,
  /\bquit\s*\(/,
  /\binput\s*\(/,
  /\bglobals\s*\(/,
  /\blocals\s*\(/,
];

/** 破坏回测一致性的模式 */
const BACKTEST_BREAKING_PATTERNS = [/\bdatetime\s*\.\s*now\s*\(/, /\bdate\s*\.\s*today\s*\(/];

/** 验证结果 */
export type ValidateResult = {
  valid: boolean;
  errors: string[];
  warnings?: string[];
};

/**
 * 移除 Python 代码中的注释
 */
function removePythonComments(code: string): string {
  const lines = code.split("\n");
  const result: string[] = [];

  let inString = false;
  let stringChar = "";

  for (const line of lines) {
    let cleaned = "";
    let i = 0;

    while (i < line.length) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (!inString) {
        if (char === '"' || char === "'") {
          if (nextChar === char && line[i + 2] === char) {
            inString = true;
            stringChar = char + char + char;
            cleaned += char + nextChar + line[i + 2];
            i += 3;
            continue;
          }
          inString = true;
          stringChar = char;
          cleaned += char;
          i += 1;
          continue;
        }
        if (char === "#") {
          break;
        }
        cleaned += char;
        i += 1;
      } else {
        cleaned += char;
        if (
          (stringChar.length === 1 && char === stringChar) ||
          (stringChar.length === 3 &&
            char === stringChar[0] &&
            nextChar === stringChar[1] &&
            line[i + 2] === stringChar[2])
        ) {
          inString = false;
          stringChar = "";
        }
        i += 1;
      }
    }

    result.push(cleaned);
  }

  return result.join("\n");
}

/**
 * 验证 symbol 格式
 */
function validateSymbol(symbol: string): { valid: boolean; market?: string } {
  if (SYMBOL_PATTERNS.crypto.test(symbol)) {
    return { valid: true, market: "Crypto" };
  }
  if (SYMBOL_PATTERNS.aShare.test(symbol)) {
    if (symbol.startsWith("6") || symbol.startsWith("0") || symbol.startsWith("3")) {
      if (symbol.startsWith("5") && symbol.endsWith(".SH")) {
        return { valid: true, market: "ETF" };
      }
      if (symbol.startsWith("000") && symbol.endsWith(".SH")) {
        return { valid: true, market: "Index" };
      }
      return { valid: true, market: "CN" };
    }
    return { valid: true, market: "CN" };
  }
  if (SYMBOL_PATTERNS.etf.test(symbol)) {
    return { valid: true, market: "ETF" };
  }
  if (SYMBOL_PATTERNS.index.test(symbol)) {
    return { valid: true, market: "Index" };
  }
  if (SYMBOL_PATTERNS.hkStock.test(symbol)) {
    return { valid: true, market: "HK" };
  }
  if (SYMBOL_PATTERNS.usStock.test(symbol)) {
    return { valid: true, market: "US" };
  }
  if (SYMBOL_PATTERNS.futures.test(symbol)) {
    return { valid: true, market: "Futures" };
  }
  return { valid: false };
}

/**
 * 提取 YAML 块内容
 * 提取指定块名下的所有内容（缩进的子行）
 */
function extractYamlBlock(yamlContent: string, blockName: string): string {
  const lines = yamlContent.split("\n");
  const result: string[] = [];
  let inBlock = false;
  let blockIndent = -1;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inBlock) {
      if (trimmed === `${blockName}:` || trimmed.startsWith(`${blockName}:`)) {
        inBlock = true;
        blockIndent = line.length - line.trimStart().length;
        const afterColon = trimmed.slice(blockName.length + 1).trim();
        if (afterColon) {
          result.push(afterColon);
        }
        continue;
      }
    } else {
      if (line.trim() === "") {
        continue;
      }
      const currentIndent = line.length - line.trimStart().length;
      if (currentIndent > blockIndent) {
        result.push(line);
      } else if (currentIndent <= blockIndent && trimmed && !trimmed.startsWith("#")) {
        break;
      }
    }
  }

  return result.join("\n");
}

/**
 * 检查字段是否存在
 */
function hasField(block: string, fieldName: string): boolean {
  const regex = new RegExp(`^\\s*${fieldName}\\s*:`, "m");
  return regex.test(block);
}

/**
 * 获取字段值
 */
function getFieldValue(block: string, fieldName: string): string | null {
  const regex = new RegExp(`^\\s*${fieldName}\\s*:\\s*(.+)$`, "m");
  const match = regex.exec(block);
  return match ? match[1].trim() : null;
}

/**
 * 验证 FEP v2.0 fep.yaml 结构
 */
function validateFepYaml(
  fepStr: string,
  errors: string[],
  warnings: string[],
): { hasUniverse: boolean } {
  let hasUniverse = false;

  // 检查 fep 版本
  const fepMatch = /^\s*fep\s*:\s*["']?([^"'\s]+)["']?/m.exec(fepStr);
  if (!fepMatch) {
    errors.push("fep.yaml 必须包含 'fep:' 版本声明（例如 fep: \"2.0\"）");
  } else if (fepMatch[1] !== FEP_VERSION) {
    errors.push(
      `fep.yaml 版本必须为 "${FEP_VERSION}"，当前为 "${fepMatch[1]}"。请升级到 FEP v2.0 格式。`,
    );
  }

  // ── identity 验证 ──
  if (!hasField(fepStr, "identity")) {
    errors.push("fep.yaml 必须包含 'identity:' 节");
  } else {
    const identityBlock = extractYamlBlock(fepStr, "identity");

    // 必填字段检查
    const requiredIdentityFields = [
      { field: "id", message: "策略唯一标识" },
      { field: "name", message: "策略显示名称" },
      { field: "type", message: "策略类型（strategy）" },
      { field: "version", message: "语义化版本号（如 1.0.0）" },
      { field: "style", message: "策略风格" },
      { field: "visibility", message: "可见性（public/private/unlisted）" },
      { field: "summary", message: "策略简介" },
      { field: "description", message: "策略描述" },
      { field: "license", message: "许可证" },
      { field: "changelog", message: "变更日志" },
      { field: "tags", message: "标签" },
    ];

    for (const { field, message } of requiredIdentityFields) {
      if (!hasField(identityBlock, field)) {
        errors.push(`fep.yaml identity 必须包含 '${field}'（${message}）`);
      }
    }

    // author.name 必填
    if (!hasField(identityBlock, "author")) {
      errors.push("fep.yaml identity 必须包含 'author' 节");
    } else {
      const authorBlock = extractYamlBlock(identityBlock, "author");
      if (!hasField(authorBlock, "name")) {
        errors.push("fep.yaml identity.author 必须包含 'name'（作者名）");
      }
    }

    // style 枚举验证
    const styleValue = getFieldValue(identityBlock, "style");
    if (styleValue) {
      const cleanedStyle = styleValue.replace(/["']/g, "");
      if (!VALID_STYLES.includes(cleanedStyle as FepV2Style)) {
        errors.push(`fep.yaml identity.style 必须为以下值之一: ${VALID_STYLES.join(", ")}`);
      }
    }

    // visibility 枚举验证
    const visibilityValue = getFieldValue(identityBlock, "visibility");
    if (visibilityValue) {
      const cleanedVisibility = visibilityValue.replace(/["']/g, "");
      if (!VALID_VISIBILITY.includes(cleanedVisibility)) {
        errors.push(
          `fep.yaml identity.visibility 必须为以下值之一: ${VALID_VISIBILITY.join(", ")}`,
        );
      }
    }

    // license 枚举验证
    const licenseValue = getFieldValue(identityBlock, "license");
    if (licenseValue) {
      const cleanedLicense = licenseValue.replace(/["']/g, "");
      if (!VALID_LICENSES.includes(cleanedLicense)) {
        warnings.push(`fep.yaml identitylicense 建议: ${VALID_LICENSES.join(", ")}`);
      }
    }

    // tags 格式验证
    const tagsValue = getFieldValue(identityBlock, "tags");
    if (tagsValue && !tagsValue.startsWith("[")) {
      warnings.push("identity.tags 应使用行内数组格式，如: tags: [trend, btc, crypto]");
    }
  }

  // ── technical 验证（可选，有默认值）──
  if (hasField(fepStr, "technical")) {
    const technicalBlock = extractYamlBlock(fepStr, "technical");

    const langValue = getFieldValue(technicalBlock, "language");
    if (langValue && langValue.replace(/["']/g, "") !== "python") {
      warnings.push('technical.language 建议使用 "python"');
    }

    const entryValue = getFieldValue(technicalBlock, "entryPoint");
    if (entryValue && !entryValue.endsWith("strategy.py")) {
      warnings.push("technical.entryPoint 建议使用 strategy.py");
    }
  }

  // ── backtest 验证（必填）──
  if (!hasField(fepStr, "backtest")) {
    errors.push("fep.yaml 必须包含 'backtest:' 节");
  } else {
    const backtestBlock = extractYamlBlock(fepStr, "backtest");

    // symbol 必填
    if (!hasField(backtestBlock, "symbol")) {
      errors.push("fep.yaml backtest 必须包含 'symbol'（交易品种）");
    } else {
      const symbolValue = getFieldValue(backtestBlock, "symbol");
      if (symbolValue) {
        const cleanedSymbol = symbolValue.replace(/["']/g, "");
        const symbolResult = validateSymbol(cleanedSymbol);
        if (!symbolResult.valid) {
          warnings.push(`backtest.symbol "${cleanedSymbol}" 格式未被识别，请确保正确`);
        }
      }
    }

    // defaultPeriod 必填
    if (!hasField(backtestBlock, "defaultPeriod")) {
      errors.push("fep.yaml backtest 必须包含 'defaultPeriod'");
    } else {
      const periodBlock = extractYamlBlock(backtestBlock, "defaultPeriod");
      if (!hasField(periodBlock, "startDate")) {
        errors.push("fep.yaml backtest.defaultPeriod 必须包含 'startDate'");
      }
      if (!hasField(periodBlock, "endDate")) {
        errors.push("fep.yaml backtest.defaultPeriod 必须包含 'endDate'");
      }
    }

    // initialCapital 必填
    if (!hasField(backtestBlock, "initialCapital")) {
      errors.push("fep.yaml backtest 必须包含 'initialCapital'（初始资金）");
    }

    // timeframe 枚举验证（可选）
    const timeframeValue = getFieldValue(backtestBlock, "timeframe");
    if (timeframeValue) {
      const cleanedTimeframe = timeframeValue.replace(/["']/g, "");
      if (!VALID_TIMEFRAMES.includes(cleanedTimeframe as FepV2Timeframe)) {
        errors.push(`fep.yaml backtest.timeframe 必须为以下值之一: ${VALID_TIMEFRAMES.join(", ")}`);
      }
    }

    // universe 检测
    if (hasField(backtestBlock, "universe")) {
      hasUniverse = true;
      const universeBlock = extractYamlBlock(backtestBlock, "universe");
      if (!hasField(universeBlock, "symbols")) {
        errors.push("fep.yaml backtest.universe 必须包含 'symbols' 数组");
      }
    }

    // rebalance 验证（可选）
    if (hasField(backtestBlock, "rebalance")) {
      const rebalanceBlock = extractYamlBlock(backtestBlock, "rebalance");
      const freqValue = getFieldValue(rebalanceBlock, "frequency");
      if (freqValue) {
        const validFreq = ["daily", "weekly", "monthly"];
        if (!validFreq.includes(freqValue.replace(/["']/g, ""))) {
          errors.push(`fep.yaml backtest.rebalance.frequency 必须为: ${validFreq.join(", ")}`);
        }
      }
    }
  }

  // ── risk 验证（可选）──
  if (hasField(fepStr, "risk")) {
    const riskBlock = extractYamlBlock(fepStr, "risk");
    const thresholdValue = getFieldValue(riskBlock, "maxDrawdownThreshold");
    if (thresholdValue) {
      const num = parseFloat(thresholdValue);
      if (isNaN(num) || num < 0 || num > 100) {
        warnings.push("risk.maxDrawdownThreshold 应为 0-100 之间的数值");
      }
    }
  }

  // ── paper 验证（可选）──
  if (hasField(fepStr, "paper")) {
    const paperBlock = extractYamlBlock(fepStr, "paper");
    const barIntervalValue = getFieldValue(paperBlock, "barIntervalSeconds");
    if (barIntervalValue) {
      const num = parseInt(barIntervalValue, 10);
      if (isNaN(num) || num < 1) {
        warnings.push("paper.barIntervalSeconds 应为正整数");
      }
    }
  }

  return { hasUniverse };
}

/**
 * 验证策略脚本
 */
function validateStrategyScript(
  scriptStr: string,
  hasUniverse: boolean,
  errors: string[],
  warnings: string[],
): void {
  const codeWithoutComments = removePythonComments(scriptStr);

  // 检查策略函数
  const hasCompute =
    /\bdef\s+compute\s*\(\s*data\s*\)/.test(scriptStr) ||
    /\bdef\s+compute\s*\(\s*data\s*,\s*context\s*(?:=\s*None)?\s*\)/.test(scriptStr);
  const hasSelect = /\bdef\s+select\s*\(\s*universe\s*\)/.test(scriptStr);

  if (!hasCompute && !hasSelect) {
    errors.push("scripts/strategy.py 必须定义 compute(data) 或 select(universe) 函数");
  }

  // 如果有 universe 配置，推荐使用 select
  if (hasUniverse && !hasSelect) {
    warnings.push("backtest 配置了 universe，建议使用 select(universe) 函数实现多标的策略");
  }

  // 如果没有 universe 但使用 select，给出警告
  if (!hasUniverse && hasSelect && !hasCompute) {
    warnings.push("使用 select(universe) 函数时，建议在 backtest 中配置 universe");
  }

  // 检查返回值结构（简单检查）
  if (hasCompute && !/\baction\b/.test(scriptStr)) {
    warnings.push("compute(data) 返回值应包含 action 字段（buy/sell/hold/target）");
  }

  // 检查禁止的 import
  for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
    if (pattern.test(scriptStr)) {
      const match = pattern.exec(scriptStr);
      const matchStr = match ? match[0] : pattern.source;
      errors.push(`scripts/strategy.py 包含禁止的导入: ${matchStr}（服务器将拒绝）`);
    }
  }

  // 检查禁止的函数调用（忽略注释）
  for (const pattern of FORBIDDEN_CALL_PATTERNS) {
    if (pattern.test(codeWithoutComments)) {
      const match = pattern.exec(codeWithoutComments);
      const matchStr = match ? match[0] : pattern.source;
      errors.push(`scripts/strategy.py 包含禁止的函数调用: ${matchStr}（服务器将拒绝）`);
    }
  }

  // 检查破坏回测一致性的模式（忽略注释）
  for (const pattern of BACKTEST_BREAKING_PATTERNS) {
    if (pattern.test(codeWithoutComments)) {
      const match = pattern.exec(codeWithoutComments);
      const matchStr = match ? match[0] : pattern.source;
      errors.push(
        `scripts/strategy.py 包含破坏回测一致性的调用: ${matchStr}（请使用回测时间而非实时时间）`,
      );
    }
  }
}

/**
 * 验证策略包目录（FEP v2.0）
 * @param dirPath 策略包目录路径
 * @returns 验证结果
 */
export async function validateStrategyPackage(dirPath: string): Promise<ValidateResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const normalizedDir = path.resolve(dirPath);
  const fepPath = path.join(normalizedDir, "fep.yaml");
  const scriptDir = path.join(normalizedDir, "scripts");
  const strategyPath = path.join(scriptDir, "strategy.py");

  // ── 检查必需文件 ──
  let fepContent: string;
  try {
    const raw = await readFile(fepPath, "utf-8");
    fepContent = typeof raw === "string" ? raw : String(raw ?? "");
  } catch {
    errors.push(`缺少或无法读取 fep.yaml: ${fepPath}`);
    return { valid: false, errors };
  }

  let strategyContent: string;
  try {
    const raw = await readFile(strategyPath, "utf-8");
    strategyContent = typeof raw === "string" ? raw : String(raw ?? "");
  } catch {
    errors.push(`缺少或无法读取 scripts/strategy.py: ${strategyPath}`);
    return { valid: false, errors };
  }

  // ── 验证 fep.yaml ──
  const { hasUniverse } = validateFepYaml(fepContent, errors, warnings);

  // ── 验证 strategy.py ──
  validateStrategyScript(strategyContent, hasUniverse, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
