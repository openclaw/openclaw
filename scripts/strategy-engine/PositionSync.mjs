/**
 * PositionSync.mjs — 啟動時從券商 API 同步現有部位到策略引擎
 *
 * 用途：避免策略引擎不知道手動/歷史部位，導致重複開倉或方向衝突
 * 流程：
 *   1. 從 CapitalHftService 拉取國內期 + 海外期部位
 *   2. 解析合約代碼、方向、口數
 *   3. 注入對應策略的 _position 狀態
 */

const BASE_URL = process.env.CAPITAL_HFT_URL ?? "http://localhost:8765";

/**
 * 從群益 API 取得所有現有部位
 * @returns {Array<{instrument: string, direction: 'long'|'short', qty: number, avgPrice: number}>}
 */
export async function fetchBrokerPositions() {
  const positions = [];

  // 國內期部位
  try {
    const res = await fetch(`${BASE_URL}/api/positions`);
    const data = await res.json();
    if (data.positions?.length) {
      for (const p of data.positions) {
        positions.push({
          instrument: p.stock ?? p.instrument ?? "",
          direction: p.buySell === "B" ? "long" : "short",
          qty: Number.parseInt(p.qty ?? p.position ?? "0", 10),
          avgPrice: Number.parseFloat(p.avgCost ?? p.avgPrice ?? "0"),
          market: "domestic",
        });
      }
    }
  } catch {
    /* 國內期無部位或不可達 */
  }

  // 海外期部位
  try {
    const res = await fetch(`${BASE_URL}/api/os-position`);
    const data = await res.json();
    if (data.rawData) {
      // rawData 格式: "market,accountName,accountId,contract,name,buySell,qty,avgPrice,..."
      const fields = data.rawData.split(",");
      if (fields.length >= 8) {
        const contract = (fields[3] ?? "").trim(); // e.g. "CN     202605"
        const buySell = (fields[5] ?? "").trim(); // "B" or "S"
        const qty = Number.parseInt(fields[6] ?? "0", 10);
        const avgPrice = Number.parseFloat(fields[7] ?? "0");
        // 從合約代碼提取商品（去掉年月）
        const instrument = contract.replace(/\s+\d{6}$/, "").trim() + "0000";

        if (qty > 0) {
          positions.push({
            instrument,
            direction: buySell === "B" ? "long" : "short",
            qty,
            avgPrice,
            market: "overseas",
            rawContract: contract,
          });
        }
      }
    }
  } catch {
    /* 海外期無部位或不可達 */
  }

  return positions;
}

/**
 * 將券商部位同步到策略引擎的策略實例
 * @param {StrategyEngine} engine
 * @param {Array} positions - fetchBrokerPositions() 的結果
 */
export function syncPositionsToEngine(engine, positions) {
  if (!positions.length) {
    return { synced: 0, skipped: 0 };
  }

  let synced = 0,
    skipped = 0;

  for (const pos of positions) {
    // 找到匹配此商品的策略
    const matched = engine.strategies.filter((s) => {
      const sInst = (s.instrument ?? "").toUpperCase();
      const pInst = (pos.instrument ?? "").toUpperCase();
      return sInst === pInst || sInst.startsWith(pInst.replace("0000", ""));
    });

    if (matched.length === 0) {
      skipped++;
      continue;
    }

    // 將部位注入第一個匹配的策略（避免多策略衝突開倉）
    const target = matched[0];
    const posValue = pos.direction === "long" ? pos.qty : -pos.qty;
    target._position = posValue;
    target._entryPrice = pos.avgPrice;
    if (pos.direction === "long") {
      target._highSinceEntry = pos.avgPrice;
      target._lowSinceEntry = Infinity;
    } else {
      target._lowSinceEntry = pos.avgPrice;
      target._highSinceEntry = 0;
    }
    synced++;
    console.log(
      `[PositionSync] ${pos.instrument} ${pos.direction} x${pos.qty} @${pos.avgPrice} → ${target.name}`,
    );
  }

  return { synced, skipped, total: positions.length };
}

export default { fetchBrokerPositions, syncPositionsToEngine };
