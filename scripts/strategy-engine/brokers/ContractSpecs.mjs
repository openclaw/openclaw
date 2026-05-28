export const SPEC_METADATA = Object.freeze({
  source: "claude/angry-bohr-619b69 ContractSpecs reviewed and safety-hardened",
  marginPolicy: "indicative_only_not_broker_authoritative",
  liveOrderPolicy: "read_only_reference_data_no_order_execution",
});

const MONTH_CODES_SOURCE = {
  F: 1,
  G: 2,
  H: 3,
  J: 4,
  K: 5,
  M: 6,
  N: 7,
  Q: 8,
  U: 9,
  V: 10,
  X: 11,
  Z: 12,
};

function spec({
  exchange,
  description,
  currency,
  pointValue,
  tickSize,
  tickValue,
  indicativeMargin,
  tradingHours,
  timezone,
  months,
  underlying,
  category,
}) {
  return Object.freeze({
    exchange,
    description,
    currency,
    pointValue,
    tickSize,
    tickValue,
    indicativeMargin,
    margin: indicativeMargin,
    marginPolicy: SPEC_METADATA.marginPolicy,
    tradingHours: Object.freeze({ ...tradingHours }),
    timezone,
    months: Object.freeze([...months]),
    underlying,
    category,
  });
}

const quarterly = ["H", "M", "U", "Z"];
const allMonths = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];

export const CONTRACT_SPECS = Object.freeze({
  ES: spec({
    exchange: "CME",
    description: "E-mini S&P 500",
    currency: "USD",
    pointValue: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    indicativeMargin: 12000,
    tradingHours: { regular: "21:30-04:00", extended: "06:00-05:00" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "S&P 500 Index",
    category: "index",
  }),
  MES: spec({
    exchange: "CME",
    description: "Micro E-mini S&P 500",
    currency: "USD",
    pointValue: 5,
    tickSize: 0.25,
    tickValue: 1.25,
    indicativeMargin: 1200,
    tradingHours: { regular: "21:30-04:00", extended: "06:00-05:00" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "S&P 500 Index",
    category: "index",
  }),
  NQ: spec({
    exchange: "CME",
    description: "E-mini Nasdaq-100",
    currency: "USD",
    pointValue: 20,
    tickSize: 0.25,
    tickValue: 5,
    indicativeMargin: 17000,
    tradingHours: { regular: "21:30-04:00", extended: "06:00-05:00" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "Nasdaq-100 Index",
    category: "index",
  }),
  MNQ: spec({
    exchange: "CME",
    description: "Micro E-mini Nasdaq-100",
    currency: "USD",
    pointValue: 2,
    tickSize: 0.25,
    tickValue: 0.5,
    indicativeMargin: 1700,
    tradingHours: { regular: "21:30-04:00", extended: "06:00-05:00" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "Nasdaq-100 Index",
    category: "index",
  }),
  YM: spec({
    exchange: "CBOT",
    description: "E-mini Dow Jones",
    currency: "USD",
    pointValue: 5,
    tickSize: 1,
    tickValue: 5,
    indicativeMargin: 8500,
    tradingHours: { regular: "21:30-04:00", extended: "06:00-05:00" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "Dow Jones Industrial Average",
    category: "index",
  }),
  MYM: spec({
    exchange: "CBOT",
    description: "Micro E-mini Dow Jones",
    currency: "USD",
    pointValue: 0.5,
    tickSize: 1,
    tickValue: 0.5,
    indicativeMargin: 850,
    tradingHours: { regular: "21:30-04:00", extended: "06:00-05:00" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "Dow Jones Industrial Average",
    category: "index",
  }),
  RTY: spec({
    exchange: "CME",
    description: "E-mini Russell 2000",
    currency: "USD",
    pointValue: 50,
    tickSize: 0.1,
    tickValue: 5,
    indicativeMargin: 7000,
    tradingHours: { regular: "21:30-04:00", extended: "06:00-05:00" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "Russell 2000 Index",
    category: "index",
  }),
  M2K: spec({
    exchange: "CME",
    description: "Micro E-mini Russell 2000",
    currency: "USD",
    pointValue: 5,
    tickSize: 0.1,
    tickValue: 0.5,
    indicativeMargin: 700,
    tradingHours: { regular: "21:30-04:00", extended: "06:00-05:00" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "Russell 2000 Index",
    category: "index",
  }),
  VX: spec({
    exchange: "CBOE",
    description: "CBOE Volatility Index Futures",
    currency: "USD",
    pointValue: 1000,
    tickSize: 0.05,
    tickValue: 50,
    indicativeMargin: 5000,
    tradingHours: { regular: "21:30-04:15" },
    timezone: "America/Chicago",
    months: allMonths,
    underlying: "VIX Index",
    category: "volatility",
  }),
  CL: spec({
    exchange: "NYMEX",
    description: "WTI Crude Oil",
    currency: "USD",
    pointValue: 1000,
    tickSize: 0.01,
    tickValue: 10,
    indicativeMargin: 5000,
    tradingHours: { regular: "06:00-05:00", pit: "21:00-04:15" },
    timezone: "America/New_York",
    months: allMonths,
    underlying: "West Texas Intermediate Crude Oil (1000 bbl)",
    category: "energy",
  }),
  MCL: spec({
    exchange: "NYMEX",
    description: "Micro WTI Crude Oil (100 bbl)",
    currency: "USD",
    pointValue: 100,
    tickSize: 0.01,
    tickValue: 1,
    indicativeMargin: 500,
    tradingHours: { regular: "06:00-05:00" },
    timezone: "America/New_York",
    months: allMonths,
    underlying: "West Texas Intermediate Crude Oil (100 bbl)",
    category: "energy",
  }),
  NG: spec({
    exchange: "NYMEX",
    description: "Natural Gas",
    currency: "USD",
    pointValue: 10000,
    tickSize: 0.001,
    tickValue: 10,
    indicativeMargin: 3000,
    tradingHours: { regular: "06:00-05:00" },
    timezone: "America/New_York",
    months: allMonths,
    underlying: "Natural Gas (10,000 MMBtu)",
    category: "energy",
  }),
  GC: spec({
    exchange: "COMEX",
    description: "Gold Futures",
    currency: "USD",
    pointValue: 100,
    tickSize: 0.1,
    tickValue: 10,
    indicativeMargin: 8000,
    tradingHours: { regular: "06:00-05:00", pit: "20:20-01:30" },
    timezone: "America/New_York",
    months: ["G", "J", "M", "Q", "V", "Z"],
    underlying: "Gold (100 troy oz)",
    category: "metal",
  }),
  MGC: spec({
    exchange: "COMEX",
    description: "Micro Gold Futures (10 oz)",
    currency: "USD",
    pointValue: 10,
    tickSize: 0.1,
    tickValue: 1,
    indicativeMargin: 800,
    tradingHours: { regular: "06:00-05:00" },
    timezone: "America/New_York",
    months: ["G", "J", "M", "Q", "V", "Z"],
    underlying: "Gold (10 troy oz)",
    category: "metal",
  }),
  SI: spec({
    exchange: "COMEX",
    description: "Silver Futures",
    currency: "USD",
    pointValue: 5000,
    tickSize: 0.005,
    tickValue: 25,
    indicativeMargin: 6000,
    tradingHours: { regular: "06:00-05:00" },
    timezone: "America/New_York",
    months: ["H", "K", "N", "U", "Z"],
    underlying: "Silver (5000 troy oz)",
    category: "metal",
  }),
  HG: spec({
    exchange: "COMEX",
    description: "Copper Futures",
    currency: "USD",
    pointValue: 25000,
    tickSize: 0.0005,
    tickValue: 12.5,
    indicativeMargin: 4500,
    tradingHours: { regular: "06:00-05:00" },
    timezone: "America/New_York",
    months: ["H", "K", "N", "U", "Z"],
    underlying: "Copper (25,000 lbs)",
    category: "metal",
  }),
  ZC: spec({
    exchange: "CBOT",
    description: "Corn Futures",
    currency: "USD",
    pointValue: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    indicativeMargin: 1200,
    tradingHours: { electronic: "19:00-07:45, 08:30-13:20", pit: "08:30-13:15" },
    timezone: "America/Chicago",
    months: ["H", "K", "N", "U", "Z"],
    underlying: "Corn (5000 bushels)",
    category: "agriculture",
  }),
  ZS: spec({
    exchange: "CBOT",
    description: "Soybean Futures",
    currency: "USD",
    pointValue: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    indicativeMargin: 2500,
    tradingHours: { electronic: "19:00-07:45, 08:30-13:20", pit: "08:30-13:15" },
    timezone: "America/Chicago",
    months: ["F", "H", "K", "N", "Q", "U", "X"],
    underlying: "Soybeans (5000 bushels)",
    category: "agriculture",
  }),
  ZW: spec({
    exchange: "CBOT",
    description: "Wheat Futures",
    currency: "USD",
    pointValue: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    indicativeMargin: 1500,
    tradingHours: { electronic: "19:00-07:45, 08:30-13:15", pit: "08:30-13:15" },
    timezone: "America/Chicago",
    months: ["H", "K", "N", "U", "Z"],
    underlying: "Wheat (5000 bushels)",
    category: "agriculture",
  }),
  ZN: spec({
    exchange: "CBOT",
    description: "10-Year US Treasury Note",
    currency: "USD",
    pointValue: 1000,
    tickSize: 0.015625,
    tickValue: 15.625,
    indicativeMargin: 1200,
    tradingHours: { electronic: "17:00-16:00 next day" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "10-Year US Treasury Note",
    category: "rates",
  }),
  ZB: spec({
    exchange: "CBOT",
    description: "30-Year US Treasury Bond",
    currency: "USD",
    pointValue: 1000,
    tickSize: 0.03125,
    tickValue: 31.25,
    indicativeMargin: 2200,
    tradingHours: { electronic: "17:00-16:00 next day" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "30-Year US Treasury Bond",
    category: "rates",
  }),
  GE: spec({
    exchange: "CME",
    description: "Eurodollar",
    currency: "USD",
    pointValue: 2500,
    tickSize: 0.005,
    tickValue: 12.5,
    indicativeMargin: 300,
    tradingHours: { electronic: "17:00-16:00 next day" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "3-Month LIBOR Rate",
    category: "rates",
  }),
  "6E": spec({
    exchange: "CME",
    description: "Euro FX Futures",
    currency: "USD",
    pointValue: 125000,
    tickSize: 0.00005,
    tickValue: 6.25,
    indicativeMargin: 2000,
    tradingHours: { electronic: "17:00-16:00 next day" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "EUR/USD (125,000 EUR)",
    category: "fx",
  }),
  "6J": spec({
    exchange: "CME",
    description: "Japanese Yen Futures",
    currency: "USD",
    pointValue: 12500000,
    tickSize: 0.0000005,
    tickValue: 6.25,
    indicativeMargin: 2000,
    tradingHours: { electronic: "17:00-16:00 next day" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "USD/JPY (12,500,000 JPY)",
    category: "fx",
  }),
  "6B": spec({
    exchange: "CME",
    description: "British Pound Futures",
    currency: "USD",
    pointValue: 62500,
    tickSize: 0.0001,
    tickValue: 6.25,
    indicativeMargin: 2000,
    tradingHours: { electronic: "17:00-16:00 next day" },
    timezone: "America/Chicago",
    months: quarterly,
    underlying: "GBP/USD (62,500 GBP)",
    category: "fx",
  }),
  FDAX: spec({
    exchange: "EUREX",
    description: "DAX Futures",
    currency: "EUR",
    pointValue: 25,
    tickSize: 0.5,
    tickValue: 12.5,
    indicativeMargin: 20000,
    tradingHours: { regular: "15:00-23:00 Asia/Taipei" },
    timezone: "Europe/Frankfurt",
    months: quarterly,
    underlying: "DAX 40 Index",
    category: "index",
  }),
  FESX: spec({
    exchange: "EUREX",
    description: "Euro Stoxx 50 Futures",
    currency: "EUR",
    pointValue: 10,
    tickSize: 1,
    tickValue: 10,
    indicativeMargin: 3000,
    tradingHours: { regular: "15:00-23:00 Asia/Taipei" },
    timezone: "Europe/Frankfurt",
    months: quarterly,
    underlying: "Euro Stoxx 50 Index",
    category: "index",
  }),
  HSI: spec({
    exchange: "HKEX",
    description: "Hang Seng Index Futures",
    currency: "HKD",
    pointValue: 50,
    tickSize: 1,
    tickValue: 50,
    indicativeMargin: 80000,
    tradingHours: { morning: "09:15-12:00", afternoon: "13:00-16:30", evening: "17:15-03:00" },
    timezone: "Asia/Hong_Kong",
    months: allMonths,
    underlying: "Hang Seng Index",
    category: "index",
  }),
  MHI: spec({
    exchange: "HKEX",
    description: "Mini Hang Seng Index Futures",
    currency: "HKD",
    pointValue: 10,
    tickSize: 1,
    tickValue: 10,
    indicativeMargin: 16000,
    tradingHours: { morning: "09:15-12:00", afternoon: "13:00-16:30", evening: "17:15-03:00" },
    timezone: "Asia/Hong_Kong",
    months: allMonths,
    underlying: "Hang Seng Index",
    category: "index",
  }),
  HHI: spec({
    exchange: "HKEX",
    description: "H-shares Index Futures",
    currency: "HKD",
    pointValue: 50,
    tickSize: 1,
    tickValue: 50,
    indicativeMargin: 30000,
    tradingHours: { morning: "09:15-12:00", afternoon: "13:00-16:30", evening: "17:15-03:00" },
    timezone: "Asia/Hong_Kong",
    months: allMonths,
    underlying: "HSCEI Index",
    category: "index",
  }),
  NK: spec({
    exchange: "SGX",
    description: "SGX Nikkei 225 Futures",
    currency: "JPY",
    pointValue: 500,
    tickSize: 5,
    tickValue: 2500,
    indicativeMargin: 500000,
    tradingHours: { daytime: "07:30-14:25", evening: "16:55-02:05" },
    timezone: "Asia/Singapore",
    months: quarterly,
    underlying: "Nikkei 225 Index",
    category: "index",
  }),
  CN: spec({
    exchange: "SGX",
    description: "SGX FTSE China A50 Futures",
    currency: "USD",
    pointValue: 1,
    tickSize: 0.5,
    tickValue: 0.5,
    indicativeMargin: 1200,
    tradingHours: { daytime: "09:00-16:35", evening: "17:35-03:15" },
    timezone: "Asia/Singapore",
    months: allMonths,
    underlying: "FTSE China A50 Index",
    category: "index",
  }),
  TW: spec({
    exchange: "SGX",
    description: "SGX MSCI Taiwan Futures",
    currency: "USD",
    pointValue: 100,
    tickSize: 0.1,
    tickValue: 10,
    indicativeMargin: 3000,
    tradingHours: { daytime: "08:45-13:45", evening: "14:25-01:00" },
    timezone: "Asia/Singapore",
    months: quarterly,
    underlying: "MSCI Taiwan Index",
    category: "index",
  }),
  TX: spec({
    exchange: "TAIFEX",
    description: "TAIEX Futures",
    currency: "TWD",
    pointValue: 200,
    tickSize: 1,
    tickValue: 200,
    indicativeMargin: 83000,
    tradingHours: { daytime: "08:45-13:45", evening: "15:00-05:00" },
    timezone: "Asia/Taipei",
    months: allMonths,
    underlying: "TAIEX",
    category: "index",
  }),
  MTX: spec({
    exchange: "TAIFEX",
    description: "Mini TAIEX Futures",
    currency: "TWD",
    pointValue: 50,
    tickSize: 1,
    tickValue: 50,
    indicativeMargin: 21000,
    tradingHours: { daytime: "08:45-13:45", evening: "15:00-05:00" },
    timezone: "Asia/Taipei",
    months: allMonths,
    underlying: "TAIEX",
    category: "index",
  }),
});

export const MONTH_CODES = Object.freeze({ ...MONTH_CODES_SOURCE });
export const MONTH_NAMES = Object.freeze({
  1: "Jan",
  2: "Feb",
  3: "Mar",
  4: "Apr",
  5: "May",
  6: "Jun",
  7: "Jul",
  8: "Aug",
  9: "Sep",
  10: "Oct",
  11: "Nov",
  12: "Dec",
});

function normalizeSymbol(symbol) {
  return String(symbol ?? "")
    .trim()
    .toUpperCase();
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function getSpec(symbol) {
  return CONTRACT_SPECS[normalizeSymbol(symbol)] ?? null;
}

export function listSymbols() {
  return Object.keys(CONTRACT_SPECS).toSorted();
}

export function getByCategory(category) {
  const target = String(category ?? "")
    .trim()
    .toLowerCase();
  return Object.entries(CONTRACT_SPECS)
    .filter(([, item]) => item.category === target)
    .map(([symbol, item]) => Object.assign({ symbol }, item));
}

export function getByExchange(exchange) {
  const target = String(exchange ?? "")
    .trim()
    .toUpperCase();
  return Object.entries(CONTRACT_SPECS)
    .filter(([, item]) => item.exchange.toUpperCase() === target)
    .map(([symbol, item]) => Object.assign({ symbol }, item));
}

export function calcPnl(symbol, entryPrice, exitPrice, qty = 1, side = "long") {
  const item = getSpec(symbol);
  if (!item) {
    throw new Error(`Unknown contract symbol: ${symbol}`);
  }

  const multiplier = side === "short" ? -1 : 1;
  return (
    (toFiniteNumber(exitPrice) - toFiniteNumber(entryPrice)) *
    toFiniteNumber(qty, 1) *
    item.pointValue *
    multiplier
  );
}

export function calcIndicativeMargin(symbol, qty = 1) {
  const item = getSpec(symbol);
  return item ? item.indicativeMargin * Math.abs(toFiniteNumber(qty, 1)) : 0;
}

export const calcMargin = calcIndicativeMargin;

export function parseContractCode(code) {
  const text = normalizeSymbol(code);
  const match = text.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{2}|\d{4})$/u);
  if (!match) {
    return null;
  }

  const yearText = match[3];
  const year =
    yearText.length === 2 ? 2000 + Number.parseInt(yearText, 10) : Number.parseInt(yearText, 10);
  return {
    symbol: match[1],
    monthCode: match[2],
    month: MONTH_CODES[match[2]],
    year,
    fullCode: text,
  };
}

export function isListedContractMonth(symbol, monthCode) {
  const item = getSpec(symbol);
  const code = normalizeSymbol(monthCode);
  return Boolean(item && item.months.includes(code));
}

export function getNearbyContracts(symbol, count = 4, asOf = new Date()) {
  const root = normalizeSymbol(symbol);
  const item = getSpec(root);
  const wanted = Math.max(0, Math.trunc(toFiniteNumber(count, 4)));
  if (!item || wanted <= 0) {
    return [];
  }

  const date = asOf instanceof Date ? asOf : new Date(asOf);
  let year = Number.isFinite(date.getTime()) ? date.getFullYear() : new Date().getFullYear();
  let month = Number.isFinite(date.getTime()) ? date.getMonth() + 1 : new Date().getMonth() + 1;
  const result = [];

  while (result.length < wanted) {
    const monthCode = Object.entries(MONTH_CODES).find(([, value]) => value === month)?.[0];
    if (monthCode && item.months.includes(monthCode)) {
      result.push(`${root}${monthCode}${String(year).slice(-2)}`);
    }

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return result;
}

export function formatSpecs(symbols = []) {
  const selected =
    Array.isArray(symbols) && symbols.length > 0
      ? symbols
          .map((symbol) => [normalizeSymbol(symbol), getSpec(symbol)])
          .filter(([, item]) => item)
      : Object.entries(CONTRACT_SPECS);

  return selected
    .map(([symbol, item]) =>
      [
        symbol,
        item.exchange,
        item.description,
        `pointValue=${item.pointValue}`,
        `tickSize=${item.tickSize}`,
        `tickValue=${item.tickValue}`,
        `indicativeMargin=${item.indicativeMargin}`,
        `marginPolicy=${item.marginPolicy}`,
      ].join(" | "),
    )
    .join("\n");
}
