import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CAPITAL_DIR = process.env.CAPITAL_HFT_DIR ?? "D:\\群益及元大API\\CapitalHftService";
const DEFAULT_STATUS_URL = "http://localhost:8765/api/status";

function toFiniteNumber(value) {
  const numeric = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function toPositiveNumber(value) {
  const numeric = toFiniteNumber(value);
  return numeric > 0 ? numeric : 0;
}

function toPositiveConfigNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export class EquityBridge {
  constructor(config = {}) {
    this.capitalDir = config.capitalDir ?? DEFAULT_CAPITAL_DIR;
    this.domesticRightsPath =
      config.domesticRightsPath ?? path.join(this.capitalDir, "hft_rights.json");
    this.overseasRightsPath =
      config.overseasRightsPath ?? path.join(this.capitalDir, "hft_os_rights.json");
    this.statusUrl = config.statusUrl ?? DEFAULT_STATUS_URL;

    this.fallbackEquity = toPositiveConfigNumber(
      config.domestic?.fallbackEquity ?? config.fallbackEquity,
      500_000,
    );
    this.fallbackOsEquity = toPositiveConfigNumber(
      config.overseas?.fallbackEquity ?? config.fallbackOsEquity,
      20_000,
    );
    this.pollIntervalMs = toPositiveConfigNumber(config.pollIntervalMs, 60_000);

    this._domesticRaw = null;
    this._overseasRaw = null;
    this._riskControls = null;
    this._refreshPromise = null;
    this._timer = null;
  }

  async refresh() {
    if (this._refreshPromise) {
      return this._refreshPromise;
    }
    this._refreshPromise = this._refreshInternal().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  getEquity() {
    const domestic = this._parseRights(this._domesticRaw, {
      fallback: this.fallbackEquity,
      currency: "TWD",
    });
    const overseas = this._parseRights(this._overseasRaw, {
      fallback: this.fallbackOsEquity,
      currency: "USD",
    });
    return {
      domestic,
      overseas,
      total: {
        TWD: domestic.rights,
        USD: overseas.rights,
      },
      currency: {
        domestic: "TWD",
        overseas: "USD",
      },
      source: domestic.source === "broker" || overseas.source === "broker" ? "mixed" : "fallback",
      riskControls: this._riskControls ? { ...this._riskControls } : null,
    };
  }

  getDomesticCapital() {
    const domestic = this.getEquity().domestic;
    return domestic.rights > 0 ? domestic.rights : this.fallbackEquity;
  }

  getOverseasCapital() {
    const overseas = this.getEquity().overseas;
    return overseas.rights > 0 ? overseas.rights : this.fallbackOsEquity;
  }

  getMaxPositionContracts() {
    const maxContracts = toPositiveNumber(this._riskControls?.maxPositionContracts);
    return maxContracts > 0 ? Math.floor(maxContracts) : null;
  }

  startPolling(intervalMs = this.pollIntervalMs) {
    this.pollIntervalMs = toPositiveConfigNumber(intervalMs, this.pollIntervalMs);
    void this.refresh();
    if (this._timer) {
      clearInterval(this._timer);
    }
    this._timer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
  }

  stopPolling() {
    if (!this._timer) {
      return;
    }
    clearInterval(this._timer);
    this._timer = null;
  }

  async _refreshInternal() {
    const [domestic, overseas, riskControls] = await Promise.all([
      this._readRights(this.domesticRightsPath),
      this._readRights(this.overseasRightsPath),
      this._readRiskControls(),
    ]);
    this._domesticRaw = domestic;
    this._overseasRaw = overseas;
    if (riskControls) {
      this._riskControls = riskControls;
    }
  }

  async _readRights(filePath) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async _readRiskControls() {
    try {
      const response = await fetch(this.statusUrl, { method: "GET" });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json();
      const riskControls =
        payload && typeof payload === "object" && payload.riskControls
          ? payload.riskControls
          : null;
      if (!riskControls || typeof riskControls !== "object") {
        return null;
      }
      const maxPositionContracts = toPositiveNumber(riskControls.maxPositionContracts);
      return {
        maxPositionContracts: maxPositionContracts > 0 ? Math.floor(maxPositionContracts) : null,
      };
    } catch {
      return null;
    }
  }

  _parseRights(data, options) {
    const fallback = options.fallback;
    const rightsRaw = toPositiveNumber(data?.rights);
    const availableRaw = toPositiveNumber(data?.availableBalance);
    const margin = toFiniteNumber(data?.margin);
    const useFallback = rightsRaw <= 0;
    const rights = useFallback ? fallback : rightsRaw;
    const available = availableRaw > 0 ? availableRaw : rights;
    return {
      rights,
      available,
      margin,
      currency: options.currency,
      source: useFallback ? "fallback" : "broker",
      rawRights: rightsRaw,
      rawAvailable: availableRaw,
      updatedAt: data?.generatedAt ?? null,
    };
  }
}
