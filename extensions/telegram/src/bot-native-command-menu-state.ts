// Owns Telegram command-menu identity and durable locale state.
import type { LanguageCode } from "grammy/types";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOptionalTelegramRuntime } from "./runtime.js";
import {
  fingerprintTelegramBotToken,
  resolveTelegramBotUserIdFromToken,
} from "./token-fingerprint.js";

const TELEGRAM_MENU_LOCALE_LEDGER_VERSION = 1;
const TELEGRAM_MENU_LOCALE_LEDGER_NAMESPACE = "telegram.command-menu-locales";
const TELEGRAM_MENU_LOCALE_LEDGER_MAX_ENTRIES = 1_000;
// Record exhaustiveness makes grammY language-code additions or removals fail typecheck.
const TELEGRAM_MENU_LANGUAGE_CODE_RECORD = {
  ab: true,
  aa: true,
  af: true,
  ak: true,
  sq: true,
  am: true,
  ar: true,
  an: true,
  hy: true,
  as: true,
  av: true,
  ae: true,
  ay: true,
  az: true,
  bm: true,
  ba: true,
  eu: true,
  be: true,
  bn: true,
  bi: true,
  bs: true,
  br: true,
  bg: true,
  my: true,
  ca: true,
  ch: true,
  ce: true,
  ny: true,
  zh: true,
  cu: true,
  cv: true,
  kw: true,
  co: true,
  cr: true,
  hr: true,
  cs: true,
  da: true,
  dv: true,
  nl: true,
  dz: true,
  en: true,
  eo: true,
  et: true,
  ee: true,
  fo: true,
  fj: true,
  fi: true,
  fr: true,
  fy: true,
  ff: true,
  gd: true,
  gl: true,
  lg: true,
  ka: true,
  de: true,
  el: true,
  kl: true,
  gn: true,
  gu: true,
  ht: true,
  ha: true,
  he: true,
  hz: true,
  hi: true,
  ho: true,
  hu: true,
  is: true,
  io: true,
  ig: true,
  id: true,
  ia: true,
  ie: true,
  iu: true,
  ik: true,
  ga: true,
  it: true,
  ja: true,
  jv: true,
  kn: true,
  kr: true,
  ks: true,
  kk: true,
  km: true,
  ki: true,
  rw: true,
  ky: true,
  kv: true,
  kg: true,
  ko: true,
  kj: true,
  ku: true,
  lo: true,
  la: true,
  lv: true,
  li: true,
  ln: true,
  lt: true,
  lu: true,
  lb: true,
  mk: true,
  mg: true,
  ms: true,
  ml: true,
  mt: true,
  gv: true,
  mi: true,
  mr: true,
  mh: true,
  mn: true,
  na: true,
  nv: true,
  nd: true,
  nr: true,
  ng: true,
  ne: true,
  no: true,
  nb: true,
  nn: true,
  ii: true,
  oc: true,
  oj: true,
  or: true,
  om: true,
  os: true,
  pi: true,
  ps: true,
  fa: true,
  pl: true,
  pt: true,
  pa: true,
  qu: true,
  ro: true,
  rm: true,
  rn: true,
  ru: true,
  se: true,
  sm: true,
  sg: true,
  sa: true,
  sc: true,
  sr: true,
  sn: true,
  sd: true,
  si: true,
  sk: true,
  sl: true,
  so: true,
  st: true,
  es: true,
  su: true,
  sw: true,
  ss: true,
  sv: true,
  tl: true,
  ty: true,
  tg: true,
  ta: true,
  tt: true,
  te: true,
  th: true,
  bo: true,
  ti: true,
  to: true,
  ts: true,
  tn: true,
  tr: true,
  tk: true,
  tw: true,
  ug: true,
  uk: true,
  ur: true,
  uz: true,
  ve: true,
  vi: true,
  vo: true,
  wa: true,
  cy: true,
  wo: true,
  xh: true,
  yi: true,
  yo: true,
  za: true,
  zu: true,
} satisfies Record<LanguageCode, true>;

type TelegramMenuLocaleLedger = {
  version: typeof TELEGRAM_MENU_LOCALE_LEDGER_VERSION;
  languageCodes: LanguageCode[];
};

type TelegramMenuLocaleLedgerHandle = {
  store: PluginStateKeyedStore<unknown>;
  value?: TelegramMenuLocaleLedger;
};

const knownLanguageCodes = new Map<string, Set<LanguageCode>>();

export function resolveTelegramMenuRemoteOwner(params: {
  accountId?: string;
  botId?: number;
  botToken?: string;
}) {
  const token = params.botToken?.trim();
  const tokenBotId = resolveTelegramBotUserIdFromToken(token);
  const botId = params.botId ?? tokenBotId;
  const tokenFingerprint = token ? fingerprintTelegramBotToken(token) : undefined;
  const fallbackKey = `${params.accountId ?? "default"}:${tokenFingerprint ?? "unknown"}`;
  const queueKey = botId === undefined ? `fallback:${fallbackKey}` : `bot:${botId}`;
  return {
    queueKey,
    hashKey: `${queueKey}:${tokenFingerprint ?? ""}`,
    ...(botId === undefined ? {} : { botId: String(botId) }),
  };
}

export function getProcessKnownTelegramMenuLocales(ownerKey: string): Set<LanguageCode> {
  let locales = knownLanguageCodes.get(ownerKey);
  if (!locales) {
    locales = new Set<LanguageCode>();
    knownLanguageCodes.set(ownerKey, locales);
  }
  return locales;
}

function isTelegramMenuLanguageCode(languageCode: string): languageCode is LanguageCode {
  return Object.hasOwn(TELEGRAM_MENU_LANGUAGE_CODE_RECORD, languageCode);
}

export function normalizeTelegramMenuLanguageCode(languageCode: string): LanguageCode | null {
  const normalized = languageCode.trim().toLowerCase();
  return isTelegramMenuLanguageCode(normalized) ? normalized : null;
}

export async function readTelegramMenuLocaleLedger(params: {
  botId: string;
  runtime: RuntimeEnv;
}): Promise<TelegramMenuLocaleLedgerHandle | null> {
  const telegramRuntime = getOptionalTelegramRuntime();
  if (!telegramRuntime) {
    params.runtime.error?.(
      `Telegram command menu locale ledger unavailable for bot ${params.botId}: runtime not initialized`,
    );
    return null;
  }
  try {
    const store = telegramRuntime.state.openKeyedStore<unknown>({
      namespace: TELEGRAM_MENU_LOCALE_LEDGER_NAMESPACE,
      maxEntries: TELEGRAM_MENU_LOCALE_LEDGER_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const stored = await store.lookup(params.botId);
    if (stored === undefined) {
      return { store };
    }
    const storedRecord = isRecord(stored) ? stored : undefined;
    const storedVersion = storedRecord?.version;
    if (
      typeof storedVersion === "number" &&
      Number.isInteger(storedVersion) &&
      storedVersion > TELEGRAM_MENU_LOCALE_LEDGER_VERSION
    ) {
      params.runtime.error?.(
        `Telegram command menu locale ledger for bot ${params.botId} uses unsupported future version ${storedVersion}; preserving it unchanged.`,
      );
      return null;
    }
    const rawCodes = Array.isArray(storedRecord?.languageCodes) ? storedRecord.languageCodes : [];
    const languageCodes = [
      ...new Set(
        rawCodes.flatMap((rawCode) => {
          const code =
            typeof rawCode === "string" ? normalizeTelegramMenuLanguageCode(rawCode) : null;
          return code ? [code] : [];
        }),
      ),
    ].toSorted();
    // Old malformed cache rows are read best effort; normal publication owns the next write.
    return { store, value: { version: TELEGRAM_MENU_LOCALE_LEDGER_VERSION, languageCodes } };
  } catch (error) {
    params.runtime.error?.(
      `Telegram command menu locale ledger unavailable for bot ${params.botId}: ${String(error)}`,
    );
    return null;
  }
}

export async function persistTelegramMenuLocaleLedger(params: {
  botId: string;
  read: TelegramMenuLocaleLedgerHandle;
  languageCodes: LanguageCode[];
}): Promise<void> {
  const current = params.read.value?.languageCodes ?? [];
  if (
    current.length === params.languageCodes.length &&
    current.every((languageCode, index) => languageCode === params.languageCodes[index])
  ) {
    return;
  }
  if (params.languageCodes.length === 0) {
    await params.read.store.delete(params.botId);
    return;
  }
  // Record locale intent before publishing so partial writes remain cleanup-visible.
  await params.read.store.register(params.botId, {
    version: TELEGRAM_MENU_LOCALE_LEDGER_VERSION,
    languageCodes: params.languageCodes,
  });
}
