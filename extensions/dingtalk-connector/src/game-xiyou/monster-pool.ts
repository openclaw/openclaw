/**
 * 妖怪数据池
 *
 * 管理所有妖怪数据，提供按品质筛选、按产品关联加权等能力。
 */

import type { Monster, MonsterQuality } from './types.ts';
import { UP_WEIGHT_MULTIPLIER, PRODUCT_WEIGHT_MULTIPLIER } from './types.ts';

/**
 * 妖怪数据（内联，避免运行时文件系统依赖）
 */
const allMonsters: Monster[] = [
  // ⬜ 普通妖怪（20 只）
  { id: "N001", name: "巡山小妖", quality: "normal", origin: "各山洞", relatedProduct: null, captureQuote: "大王叫我来巡山～" },
  { id: "N002", name: "树精", quality: "normal", origin: "荆棘岭", relatedProduct: "contact", captureQuote: "落叶归根，不过如此。" },
  { id: "N003", name: "草头神", quality: "normal", origin: "通天河畔", relatedProduct: "calendar", captureQuote: "时辰到了，该走了。" },
  { id: "N004", name: "虾兵", quality: "normal", origin: "东海", relatedProduct: "chat", captureQuote: "龙宫不是你想来就能来的！" },
  { id: "N005", name: "蟹将", quality: "normal", origin: "东海", relatedProduct: "chat", captureQuote: "横行霸道？那是我的专利。" },
  { id: "N006", name: "山神", quality: "normal", origin: "各处", relatedProduct: "attendance", captureQuote: "此山是我开，此树是我栽。" },
  { id: "N007", name: "土地公", quality: "normal", origin: "各处", relatedProduct: "contact", captureQuote: "大圣饶命，小神知无不言。" },
  { id: "N008", name: "夜叉", quality: "normal", origin: "水府", relatedProduct: "ding", captureQuote: "水底的消息，最快。" },
  { id: "N009", name: "狼妖", quality: "normal", origin: "黄风岭", relatedProduct: "todo", captureQuote: "待办事项？我只待吃人。" },
  { id: "N010", name: "蛇妖", quality: "normal", origin: "蛇盘山", relatedProduct: "devdoc", captureQuote: "嘶——文档里藏着秘密。" },
  { id: "N011", name: "鹿精", quality: "normal", origin: "比丘国", relatedProduct: "report", captureQuote: "今日份的鹿茸报告。" },
  { id: "N012", name: "兔精", quality: "normal", origin: "天竺国", relatedProduct: "calendar", captureQuote: "月宫的日程，排得满满的。" },
  { id: "N013", name: "鱼精", quality: "normal", origin: "通天河", relatedProduct: "aitable", captureQuote: "河底的账本，一条不差。" },
  { id: "N014", name: "龟精", quality: "normal", origin: "通天河", relatedProduct: "todo", captureQuote: "慢是慢了点，但待办一定完成。" },
  { id: "N015", name: "猪妖", quality: "normal", origin: "福陵山", relatedProduct: "report", captureQuote: "日报？让我先睡一觉再说。" },
  { id: "N016", name: "鸡精", quality: "normal", origin: "毒敌山", relatedProduct: "attendance", captureQuote: "打鸣就是打卡，准时得很。" },
  { id: "N017", name: "鼠精", quality: "normal", origin: "无底洞", relatedProduct: "aitable", captureQuote: "数据？我最擅长搬运了。" },
  { id: "N018", name: "蝙蝠精", quality: "normal", origin: "黄花观", relatedProduct: "ding", captureQuote: "暗夜传信，无声无息。" },
  { id: "N019", name: "石妖", quality: "normal", origin: "花果山", relatedProduct: "workbench", captureQuote: "石头里蹦出来的，不止猴子。" },
  { id: "N020", name: "柳树精", quality: "normal", origin: "荆棘岭", relatedProduct: "approval", captureQuote: "柳条一挥，审批盖章。" },
  // 🟢 精良妖怪（15 只）
  { id: "R001", name: "黑风怪", quality: "fine", origin: "黑风山", relatedProduct: "workbench", captureQuote: "这袈裟，归我了！" },
  { id: "R002", name: "黄风怪", quality: "fine", origin: "黄风岭", relatedProduct: "chat", captureQuote: "三昧神风，吹！" },
  { id: "R003", name: "白骨精", quality: "fine", origin: "白虎岭", relatedProduct: "contact", captureQuote: "变化之术，通讯录里谁是谁？" },
  { id: "R004", name: "银角大王", quality: "fine", origin: "平顶山", relatedProduct: "aitable", captureQuote: "紫金红葫芦，装！" },
  { id: "R005", name: "金角大王", quality: "fine", origin: "平顶山", relatedProduct: "aitable", captureQuote: "幌金绳，捆！" },
  { id: "R006", name: "红孩儿", quality: "fine", origin: "火云洞", relatedProduct: "ding", captureQuote: "三昧真火，DING！" },
  { id: "R007", name: "鼍龙", quality: "fine", origin: "黑水河", relatedProduct: "approval", captureQuote: "我舅舅是西海龙王，审批通过！" },
  { id: "R008", name: "蜘蛛精", quality: "fine", origin: "盘丝洞", relatedProduct: "todo", captureQuote: "七姐妹的待办，丝丝入扣。" },
  { id: "R009", name: "蝎子精", quality: "fine", origin: "琵琶洞", relatedProduct: "attendance", captureQuote: "倒马毒桩，准时打卡。" },
  { id: "R010", name: "六耳猕猴", quality: "fine", origin: "—", relatedProduct: null, captureQuote: "真假难辨，你猜我是谁？" },
  { id: "R011", name: "奔波儿灞", quality: "fine", origin: "乱石山碧波潭", relatedProduct: "chat", captureQuote: "跑腿送信，我最在行。" },
  { id: "R012", name: "灞波儿奔", quality: "fine", origin: "乱石山碧波潭", relatedProduct: "chat", captureQuote: "消息必达，使命必成。" },
  { id: "R013", name: "独角兕大王", quality: "fine", origin: "金兜山", relatedProduct: "calendar", captureQuote: "金刚琢套住你的日程。" },
  { id: "R014", name: "如意真仙", quality: "fine", origin: "解阳山", relatedProduct: "report", captureQuote: "落胎泉的日报，概不外传。" },
  { id: "R015", name: "虎力大仙", quality: "fine", origin: "车迟国", relatedProduct: "approval", captureQuote: "国师审批，一言九鼎。" },
  // 🔵 稀有妖怪（12 只）
  { id: "S001", name: "黄袍怪", quality: "rare", origin: "碗子山", relatedProduct: "report", captureQuote: "百花羞的日报，我替她写了。" },
  { id: "S002", name: "金翅大鹏", quality: "rare", origin: "狮驼岭", relatedProduct: "calendar", captureQuote: "翅膀一扇，九万里。日程？不存在的。" },
  { id: "S003", name: "青牛精", quality: "rare", origin: "金兜山", relatedProduct: "aitable", captureQuote: "金刚琢，套住你的表格。" },
  { id: "S004", name: "铁扇公主", quality: "rare", origin: "翠云山", relatedProduct: "approval", captureQuote: "芭蕉扇一扇，审批全灭。" },
  { id: "S005", name: "牛魔王", quality: "rare", origin: "积雷山", relatedProduct: "workbench", captureQuote: "我乃平天大圣，工作台归我管。" },
  { id: "S006", name: "白鹿精", quality: "rare", origin: "比丘国", relatedProduct: "attendance", captureQuote: "一千一百一十一个小儿的考勤。" },
  { id: "S007", name: "蜈蚣精", quality: "rare", origin: "黄花观", relatedProduct: "todo", captureQuote: "千目待办，一个不漏。" },
  { id: "S008", name: "玉兔精", quality: "rare", origin: "天竺国", relatedProduct: "calendar", captureQuote: "广寒宫的排班表，我说了算。" },
  { id: "S009", name: "金鼻白毛老鼠精", quality: "rare", origin: "无底洞", relatedProduct: "contact", captureQuote: "无底洞的通讯录，深不见底。" },
  { id: "S010", name: "鹿力大仙", quality: "rare", origin: "车迟国", relatedProduct: "ding", captureQuote: "呼风唤雨，DING 声如雷。" },
  { id: "S011", name: "羊力大仙", quality: "rare", origin: "车迟国", relatedProduct: "devdoc", captureQuote: "油锅里的文档，捞出来就是。" },
  { id: "S012", name: "荆棘岭十八公", quality: "rare", origin: "荆棘岭", relatedProduct: "chat", captureQuote: "松竹梅桂，群聊四友。" },
  // 🟣 史诗妖怪（10 只）
  { id: "E001", name: "黄眉大王", quality: "epic", origin: "弥勒佛的童子", relatedProduct: "approval", captureQuote: "人种袋，把你的审批全装进来。" },
  { id: "E002", name: "大鹏金翅明王", quality: "epic", origin: "如来舅舅", relatedProduct: "workbench", captureQuote: "狮驼国的工作台，三界最大。" },
  { id: "E003", name: "九灵元圣", quality: "epic", origin: "太乙天尊坐骑", relatedProduct: "aitable", captureQuote: "九个头，九张表，哪个都不能少。" },
  { id: "E004", name: "赛太岁", quality: "epic", origin: "观音坐骑金毛犼", relatedProduct: "attendance", captureQuote: "紫金铃一摇，全员到齐。" },
  { id: "E005", name: "青狮精", quality: "epic", origin: "文殊菩萨坐骑", relatedProduct: "chat", captureQuote: "狮子吼，群消息已送达。" },
  { id: "E006", name: "白象精", quality: "epic", origin: "普贤菩萨坐骑", relatedProduct: "todo", captureQuote: "长鼻一卷，待办清空。" },
  { id: "E007", name: "蠹虫精", quality: "epic", origin: "比丘国国丈", relatedProduct: "report", captureQuote: "一千一百一十一份日报，全在这了。" },
  { id: "E008", name: "金鱼精", quality: "epic", origin: "观音莲花池", relatedProduct: "calendar", captureQuote: "通天河的日程，年年祭祀。" },
  { id: "E009", name: "蟒蛇精", quality: "epic", origin: "七绝山", relatedProduct: "devdoc", captureQuote: "七绝山的文档，毒气弥漫。" },
  { id: "E010", name: "灵感大王", quality: "epic", origin: "通天河", relatedProduct: "ding", captureQuote: "金鱼一跃，DING 达四海。" },
  // 🟡 传说妖怪（8 只）
  { id: "L001", name: "混世魔王", quality: "legendary", origin: "花果山第一战", relatedProduct: null, captureQuote: "水帘洞，从此姓孙。" },
  { id: "L002", name: "牛魔王（魔化）", quality: "legendary", origin: "大力牛魔王本相", relatedProduct: null, captureQuote: "平天大圣，不服来战！" },
  { id: "L003", name: "九头虫", quality: "legendary", origin: "碧波潭万圣龙王驸马", relatedProduct: null, captureQuote: "九颗头颅，九种权限。" },
  { id: "L004", name: "百眼魔君", quality: "legendary", origin: "蜈蚣精本相", relatedProduct: null, captureQuote: "千目金光，洞察一切数据。" },
  { id: "L005", name: "大鹏金翅（本相）", quality: "legendary", origin: "遮天蔽日", relatedProduct: null, captureQuote: "三界之大，不过我翅膀之下。" },
  { id: "L006", name: "孙悟空（石猴）", quality: "legendary", origin: "花果山水帘洞", relatedProduct: null, captureQuote: "俺老孙来也！" },
  { id: "L007", name: "六耳猕猴（真身）", quality: "legendary", origin: "混沌之中", relatedProduct: null, captureQuote: "天地间第二个齐天大圣。" },
  { id: "L008", name: "白骨夫人（真身）", quality: "legendary", origin: "白虎岭深处", relatedProduct: null, captureQuote: "三打不死，方显真身。" },
];

/**
 * 获取所有妖怪
 */
export function getAllMonsters(): Monster[] {
  return allMonsters;
}

/**
 * 获取指定品质的妖怪列表
 */
export function getMonstersByQuality(quality: MonsterQuality): Monster[] {
  return allMonsters.filter(m => m.quality === quality);
}

/**
 * 根据 ID 查找妖怪
 */
export function getMonsterById(monsterId: string): Monster | undefined {
  return allMonsters.find(m => m.id === monsterId);
}

/**
 * 获取所有妖怪的总数（不含闪光变体）
 */
export function getTotalMonsterCount(): number {
  return allMonsters.length;
}

/**
 * 获取本周 UP 妖怪
 *
 * 按周数轮换，从史诗和传说池中选择
 */
export function getWeeklyUpMonster(): Monster | null {
  const upPool = allMonsters.filter(
    m => m.quality === 'epic' || m.quality === 'legendary'
  );
  if (upPool.length === 0) return null;

  const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const index = weekNumber % upPool.length;
  return upPool[index];
}

/**
 * 带权重的随机选择妖怪
 *
 * @param pool - 候选妖怪池
 * @param product - 当前 dws 产品（关联产品权重 ×3）
 * @param upMonster - 本周 UP 妖怪（权重 ×5）
 * @param randomValue - 随机数 [0, 1)
 */
export function weightedRandomSelect(
  pool: Monster[],
  product: string | null,
  upMonster: Monster | null,
  randomValue: number
): Monster {
  if (pool.length === 0) {
    throw new Error('Monster pool is empty');
  }
  if (pool.length === 1) {
    return pool[0];
  }

  // 计算每只妖怪的权重
  const weights = pool.map(monster => {
    let weight = 1;

    // 产品关联加权
    if (product && monster.relatedProduct === product) {
      weight *= PRODUCT_WEIGHT_MULTIPLIER;
    }

    // UP 池加权
    if (upMonster && monster.id === upMonster.id) {
      weight *= UP_WEIGHT_MULTIPLIER;
    }

    return weight;
  });

  // 加权随机选择
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let target = randomValue * totalWeight;

  for (let i = 0; i < pool.length; i++) {
    target -= weights[i];
    if (target <= 0) {
      return pool[i];
    }
  }

  return pool[pool.length - 1];
}
