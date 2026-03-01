/** Tushare API name mappings for stock/index/macro/derivatives/market queries. */

export const STOCK_CN_MAP: Record<string, string> = {
  quote: "daily",
  historical: "daily",
  income: "income",
  balance: "balancesheet",
  cashflow: "cashflow",
  ratios: "fina_indicator",
  moneyflow: "moneyflow",
  holders: "top10_holders",
  dividends: "dividend",
  news: "major_news",
  pledge: "pledge_stat",
  margin: "margin_detail",
  block_trade: "block_trade",
  factor: "stk_factor",
};

export const STOCK_HK_MAP: Record<string, string> = {
  quote: "hk_daily",
  historical: "hk_daily",
  income: "hk_income",
  balance: "hk_balancesheet",
  cashflow: "hk_cashflow",
  ratios: "hk_fina_indicator",
};

export const STOCK_US_MAP: Record<string, string> = {
  quote: "us_daily",
  historical: "us_daily",
  income: "us_income",
  balance: "us_balancesheet",
  cashflow: "us_cashflow",
  ratios: "us_fina_indicator",
};

export function resolveStockApi(queryType: string, market: string): string {
  if (market === "hk") return STOCK_HK_MAP[queryType] ?? STOCK_CN_MAP[queryType] ?? queryType;
  if (market === "us") return STOCK_US_MAP[queryType] ?? STOCK_CN_MAP[queryType] ?? queryType;
  return STOCK_CN_MAP[queryType] ?? queryType;
}

export const INDEX_MAP: Record<string, string> = {
  index_historical: "index_daily",
  index_constituents: "index_weight",
  index_valuation: "index_dailybasic",
  etf_historical: "fund_daily",
  etf_nav: "fund_nav",
  fund_manager: "fund_manager",
  fund_portfolio: "fund_portfolio",
  fund_share: "fund_share",
  ths_index: "ths_index",
  ths_daily: "ths_daily",
  ths_member: "ths_member",
  sector_classify: "index_classify",
};

export const MACRO_MAP: Record<string, string> = {
  gdp: "cn_gdp",
  cpi: "cn_cpi",
  ppi: "cn_ppi",
  pmi: "cn_pmi",
  m2: "cn_m",
  money_supply: "cn_m",
  social_financing: "sf",
  shibor: "shibor",
  shibor_quote: "shibor_quote",
  lpr: "shibor_lpr",
  libor: "libor",
  hibor: "hibor",
  treasury_cn: "yc_cb",
  treasury_us: "us_tycr",
  wz_index: "wz_index",
  fx: "fx_daily",
  calendar: "eco_cal",
  wb_gdp: "wb_gdp",
  wb_population: "wb_population",
  wb_inflation: "wb_inflation",
  wb_indicator: "wb_indicator",
};

export const DERIV_MAP: Record<string, string> = {
  futures_historical: "fut_daily",
  futures_info: "fut_basic",
  futures_holding: "fut_holding",
  futures_settle: "fut_settle",
  futures_warehouse: "fut_wsr",
  futures_mapping: "fut_mapping",
  option_basic: "opt_basic",
  option_daily: "opt_daily",
  option_chains: "opt_basic",
  cb_basic: "cb_basic",
  cb_daily: "cb_daily",
};

export const MARKET_MAP: Record<string, string> = {
  top_list: "top_list",
  top_inst: "top_inst",
  limit_list: "limit_list_d",
  block_trade: "block_trade",
  moneyflow_industry: "moneyflow_ind_dc",
  concept_list: "ths_index",
  concept_detail: "ths_daily",
  margin: "margin",
  margin_detail: "margin_detail",
  hsgt_flow: "moneyflow_hsgt",
  hsgt_top10: "hsgt_top10",
  index_global: "index_global",
  market_snapshot: "index_global",
  calendar_ipo: "new_share",
  suspend: "suspend_d",
  trade_calendar: "trade_cal",
};

/** Detect A-share / HK / US market from symbol suffix. */
export function detectMarket(symbol: string): "cn" | "hk" | "us" {
  const upper = symbol.toUpperCase();
  if (upper.endsWith(".HK")) return "hk";
  if (upper.endsWith(".SH") || upper.endsWith(".SZ") || upper.endsWith(".BJ")) return "cn";
  if (/^[A-Z]{1,5}$/.test(upper)) return "us";
  return "cn";
}

/** Build Tushare-style params from user-facing params. */
export function buildTushareParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (params.symbol) out.ts_code = String(params.symbol);
  if (params.start_date) out.start_date = String(params.start_date).replace(/-/g, "");
  if (params.end_date) out.end_date = String(params.end_date).replace(/-/g, "");
  if (params.trade_date) out.trade_date = String(params.trade_date).replace(/-/g, "");
  if (params.limit) out.limit = params.limit;
  if (params.exchange) out.exchange = params.exchange;
  return out;
}
