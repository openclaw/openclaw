/**
 * 妖怪逃跑引擎 (v2)
 *
 * 掉落不再等于收服。品质越高的妖怪越难降服。
 * 逃跑率受连击、法宝、buff、产品关联等因素修正，最低不低于 5%。
 * 保底触发的妖怪 100% 收服，不会逃跑。
 */

import { randomBytes } from 'crypto';
import type {
  MonsterQuality, Monster, UserProfile, DropResult, EscapeModifier,
} from './types.ts';
import { BASE_ESCAPE_RATES, MIN_ESCAPE_RATE } from './types.ts';

function cryptoRandom(): number {
  const buffer = randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
}

/**
 * 计算逃跑率修正因子列表
 */
function calculateEscapeModifiers(
  monster: Monster,
  profile: UserProfile,
  product: string,
  isBountyTarget: boolean
): EscapeModifier[] {
  const modifiers: EscapeModifier[] = [];

  // 连击加成：≥5 时 -10%，≥10 时 -20%
  if (profile.currentCombo >= 10) {
    modifiers.push({ source: 'combo', value: 0.20, description: `连击 ×${profile.currentCombo} 加成` });
  } else if (profile.currentCombo >= 5) {
    modifiers.push({ source: 'combo', value: 0.10, description: `连击 ×${profile.currentCombo} 加成` });
  }

  // 法宝"玲珑宝塔"：逃跑率 -15%
  if (profile.buffs.some(b => b.id === 'linglongta')) {
    modifiers.push({ source: 'treasure', value: 0.15, description: '玲珑宝塔' });
  }

  // 法宝"定海神针"：逃跑率 -10%
  if (profile.buffs.some(b => b.id === 'dinghaishenzhen')) {
    modifiers.push({ source: 'treasure', value: 0.10, description: '定海神针' });
  }

  // 师徒 buff（二郎真君）：逃跑率 -8%
  if (profile.buffs.some(b => b.id === 'erlang-apprentice')) {
    modifiers.push({ source: 'buff', value: 0.08, description: '二郎真君师徒' });
  }

  // 产品关联匹配：妖怪关联产品与当前命令产品一致时 -5%
  if (monster.relatedProduct && monster.relatedProduct === product) {
    modifiers.push({ source: 'product', value: 0.05, description: '产品关联匹配' });
  }

  // 悬赏令加成：悬赏目标妖怪逃跑率 -10%
  if (isBountyTarget) {
    modifiers.push({ source: 'bounty', value: 0.10, description: '悬赏令加成' });
  }

  // 活跃事件修正：逃跑率全局修正
  for (const event of profile.activeEvents.currentEvents) {
    if (event.effect.type === 'escape_rate_mod') {
      const eventValue = Math.abs(event.effect.value);
      if (event.effect.value < 0) {
        modifiers.push({ source: 'event', value: eventValue, description: `${event.name} 减益` });
      }
      // 正值（增加逃跑率）在 calculateFinalEscapeRate 中处理
    }
  }

  return modifiers;
}

/**
 * 计算最终逃跑率
 */
function calculateFinalEscapeRate(
  quality: MonsterQuality,
  isShiny: boolean,
  modifiers: EscapeModifier[],
  profile: UserProfile,
  monsterId: string
): number {
  // 闪光妖怪使用闪光逃跑率
  const baseRate = isShiny ? BASE_ESCAPE_RATES.shiny : BASE_ESCAPE_RATES[quality];

  if (baseRate === 0) return 0; // 普通妖怪不逃跑

  // 减去所有修正因子
  const totalReduction = modifiers.reduce((sum, m) => sum + m.value, 0);

  // 加上事件增加的逃跑率
  let eventIncrease = 0;
  for (const event of profile.activeEvents.currentEvents) {
    if (event.effect.type === 'escape_rate_mod' && event.effect.value > 0) {
      eventIncrease += event.effect.value;
    }
  }

  // "冤家路窄"：同一只妖怪连续逃跑 3 次，第 4 次逃跑率减半
  const consecutiveEscapes = profile.escapeHistory[monsterId] ?? 0;
  let consecutiveReduction = 0;
  if (consecutiveEscapes >= 3) {
    consecutiveReduction = (baseRate + eventIncrease - totalReduction) * 0.5;
  }

  const finalRate = baseRate + eventIncrease - totalReduction - consecutiveReduction;
  return Math.max(MIN_ESCAPE_RATE, Math.min(finalRate, 0.95));
}

/**
 * 判定妖怪是否逃跑，并更新追踪数据
 *
 * @returns 更新后的 DropResult（设置 escaped / escapeRate / escapeModifiers）
 */
export function resolveEscape(
  dropResult: DropResult,
  profile: UserProfile,
  product: string,
  isBountyTarget: boolean = false
): DropResult {
  const { monster, isShiny, isPityTriggered } = dropResult;

  // 保底触发的妖怪 100% 收服
  if (isPityTriggered) {
    return { ...dropResult, escaped: false, escapeRate: 0, escapeModifiers: [] };
  }

  // 普通妖怪不逃跑
  if (monster.quality === 'normal' && !isShiny) {
    return { ...dropResult, escaped: false, escapeRate: 0, escapeModifiers: [] };
  }

  const modifiers = calculateEscapeModifiers(monster, profile, product, isBountyTarget);
  const escapeRate = calculateFinalEscapeRate(
    monster.quality, isShiny, modifiers, profile, monster.id
  );

  const escaped = cryptoRandom() < escapeRate;

  // 更新逃跑追踪
  if (escaped) {
    profile.escapeHistory[monster.id] = (profile.escapeHistory[monster.id] ?? 0) + 1;
    profile.totalEscapes += 1;
  } else {
    // 收服成功，重置该妖怪的连续逃跑计数
    profile.escapeHistory[monster.id] = 0;
  }

  return { ...dropResult, escaped, escapeRate, escapeModifiers: modifiers };
}

/**
 * 检查"冤家路窄"效果：逃跑后的妖怪在接下来 10 次掉落内再次遇到的概率 ×2
 * 返回应该额外加权的妖怪 ID 列表
 */
export function getEscapedMonsterBoostIds(profile: UserProfile): string[] {
  return Object.entries(profile.escapeHistory)
    .filter(([_, count]) => count > 0)
    .map(([monsterId]) => monsterId);
}
