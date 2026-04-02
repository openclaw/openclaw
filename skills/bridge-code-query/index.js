/**
 * Bridge Code Query Skill
 * 桥梁规范查询
 */

const codeDatabase = {
  'GB/T 50283': {
    name: '公路桥梁设计通用规范',
    version: '2022',
    chapters: {
      '4.1': {
        title: '作用分类、代表值和作用组合',
        content: '永久作用标准值:对结构自重、预加力等,采用标准值作为代表值。可变作用标准值:汽车荷载分为公路-I级和公路-II级两个等级。'
      },
      '4.3': {
        title: '汽车荷载',
        content: '车道荷载由均布荷载和集中荷载组成。公路-I级: qk=10.5kN/m, 当计算跨径≤5m时Pk=270kN, ≥50m时Pk=360kN。公路-II级:为公路-I级的0.75倍。'
      },
      '4.3.5': {
        title: '车道荷载横向分布系数',
        content: '桥梁设计车道数应符合表4.3.1-3的规定。多车道桥梁上的汽车荷载应考虑多车道折减。'
      }
    }
  },
  'JTG 3362': {
    name: '公路钢筋混凝土及预应力混凝土桥涵设计规范',
    version: '2018',
    chapters: {
      '5.2': {
        title: '正截面承载力计算',
        content: '相对界限受压区高度ξb: HRB400钢筋取0.56。最小配筋率:不应小于0.2%和45ftd/fsd中的较大值。'
      },
      '5.2.3': {
        title: '受弯构件正截面受弯承载力',
        content: 'γ0Md ≤ fcdbx(h0-x/2) + fsd\'As\'(h0-as\')。当考虑受压钢筋时,应符合x≥2as\'的条件。'
      },
      '5.2.9': {
        title: '受弯构件斜截面受剪承载力',
        content: 'γ0Vd ≤ Vcs + Vsb + Vpb。Vcs = α1α2α3(0.45×10⁻³)bh0√(2+0.6p)ρsvfsv。箍筋配筋率ρsv不应小于0.12%。'
      }
    }
  },
  'JTG/T B02-01': {
    name: '公路桥梁抗震设计细则',
    version: '2008',
    chapters: {
      '4.1': {
        title: '抗震设防烈度和设防分类',
        content: '桥梁抗震设防类别:A类(高速公路和一级公路上的大桥、特大桥)、B类、C类、D类。E1地震作用:结构在弹性范围内工作。'
      },
      '5.3': {
        title: '设计加速度反应谱',
        content: '水平设计加速度反应谱S由下式确定: S = CixCiCsCdA。式中:Ci-重要性系数,Cs-场地系数,Cd-阻尼调整系数。'
      }
    }
  }
};

export async function execute(action, params) {
  if (action !== 'query') {
    return { error: `Unknown action: ${action}` };
  }

  const { code, article, query } = params;
  let results = [];

  if (code && article) {
    const codeInfo = codeDatabase[code];
    if (codeInfo && codeInfo.chapters[article]) {
      results.push({
        code,
        name: codeInfo.name,
        version: codeInfo.version,
        article,
        ...codeInfo.chapters[article]
      });
    }
  } else if (query) {
    results = searchCode(query);
  } else {
    results = Object.entries(codeDatabase).map(([code, info]) => ({
      code,
      name: info.name,
      version: info.version,
      chapters: Object.keys(info.chapters)
    }));
  }

  return {
    success: true,
    message: results.length > 0 ? `找到 ${results.length} 条相关条文` : '未找到相关条文',
    data: results,
    availableCodes: Object.keys(codeDatabase)
  };
}

function searchCode(keyword) {
  const results = [];
  const lowerKeyword = keyword.toLowerCase();

  for (const [codeName, codeInfo] of Object.entries(codeDatabase)) {
    for (const [articleNum, article] of Object.entries(codeInfo.chapters)) {
      if (article.title.toLowerCase().includes(lowerKeyword) ||
          article.content.toLowerCase().includes(lowerKeyword)) {
        results.push({
          code: codeName,
          name: codeInfo.name,
          version: codeInfo.version,
          article: articleNum,
          ...article
        });
      }
    }
  }

  return results;
}
