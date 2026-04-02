/**
 * Bridge Quantity Survey Skill
 * 工程量计算
 */

export async function execute(action, params) {
  if (action !== 'calculate') {
    return { error: `Unknown action: ${action}` };
  }

  const {
    bridgeType = 'girder',
    span = 30,
    width = 12,
    spanCount = 1
  } = params;

  const quantities = {
    superstructure: calculateSuperstructure({ span, width, spanCount }),
    substructure: calculateSubstructure({ spanCount }),
    foundation: calculateFoundation({ spanCount }),
    ancillary: calculateAncillary({ span, width, spanCount })
  };

  const summary = {
    concrete: 0,
    rebar: 0,
    prestress: 0
  };

  for (const part of Object.values(quantities)) {
    summary.concrete += part.concrete?.total || part.concrete || 0;
    summary.rebar += part.rebar || 0;
    summary.prestress += part.prestress || 0;
  }

  return {
    success: true,
    message: '工程量计算完成',
    data: {
      summary: {
        concrete: Math.round(summary.concrete * 10) / 10,
        rebar: Math.round(summary.rebar * 100) / 100,
        prestress: Math.round(summary.prestress * 100) / 100
      },
      details: quantities,
      costEstimate: estimateCost(summary)
    },
    reference: 'JTG/T 3832-2018 公路工程预算定额'
  };
}

function calculateSuperstructure(params) {
  const { span, width, spanCount = 1 } = params;
  const beamSpacing = 2.5;
  const beamCount = Math.floor(width / beamSpacing) + 1;
  const beamSectionArea = 1.2;
  const beamConcrete = beamSectionArea * span * beamCount * spanCount;
  const deckThickness = 0.25;
  const deckConcrete = span * width * deckThickness * spanCount;
  const jointConcrete = beamCount * span * 0.15 * spanCount;
  const totalConcrete = beamConcrete + deckConcrete + jointConcrete;
  const rebar = totalConcrete * 0.12;
  const prestress = totalConcrete * 0.03;

  return {
    name: '上部结构',
    concrete: {
      beam: Math.round(beamConcrete * 10) / 10,
      deck: Math.round(deckConcrete * 10) / 10,
      joint: Math.round(jointConcrete * 10) / 10,
      total: Math.round(totalConcrete * 10) / 10
    },
    rebar: Math.round(rebar * 100) / 100,
    prestress: Math.round(prestress * 100) / 100,
    unit: { concrete: 'm³', rebar: 't', prestress: 't' }
  };
}

function calculateSubstructure(params) {
  const { spanCount = 1 } = params;
  const pierCount = Math.max(0, spanCount - 1);
  const pierDiameter = 1.5;
  const pierHeight = 8;
  const pierColumnArea = Math.PI * Math.pow(pierDiameter / 2, 2);
  const pierConcrete = pierColumnArea * pierHeight * 2 * pierCount;
  const pierCapConcrete = 15 * pierCount;
  const abutmentConcrete = 80 * 2;
  const totalConcrete = pierConcrete + pierCapConcrete + abutmentConcrete;
  const rebar = totalConcrete * 0.1;

  return {
    name: '下部结构',
    concrete: {
      pierColumn: Math.round(pierConcrete * 10) / 10,
      pierCap: Math.round(pierCapConcrete * 10) / 10,
      abutment: Math.round(abutmentConcrete * 10) / 10,
      total: Math.round(totalConcrete * 10) / 10
    },
    rebar: Math.round(rebar * 100) / 100,
    pierCount,
    abutmentCount: 2,
    unit: { concrete: 'm³', rebar: 't' }
  };
}

function calculateFoundation(params) {
  const { spanCount = 1 } = params;
  const pierCount = Math.max(0, spanCount - 1);
  const pileDiameter = 1.2;
  const pileLength = 23;
  const pilesPerPier = 4;
  const pileConcretePerMeter = Math.PI * Math.pow(pileDiameter / 2, 2);
  const pierPiles = pileConcretePerMeter * pileLength * pilesPerPier * pierCount;
  const abutmentPiles = pileConcretePerMeter * pileLength * 6 * 2;
  const pierCapConcrete = 20 * pierCount;
  const abutmentCapConcrete = 30 * 2;
  const totalConcrete = pierPiles + abutmentPiles + pierCapConcrete + abutmentCapConcrete;
  const rebar = totalConcrete * 0.08;

  return {
    name: '基础',
    concrete: {
      pierPiles: Math.round(pierPiles * 10) / 10,
      abutmentPiles: Math.round(abutmentPiles * 10) / 10,
      caps: Math.round((pierCapConcrete + abutmentCapConcrete) * 10) / 10,
      total: Math.round(totalConcrete * 10) / 10
    },
    rebar: Math.round(rebar * 100) / 100,
    pileCount: pilesPerPier * pierCount + 6 * 2,
    unit: { concrete: 'm³', rebar: 't', pileCount: '根' }
  };
}

function calculateAncillary(params) {
  const { span, width, spanCount = 1 } = params;
  const totalLength = span * spanCount;
  const pavementArea = totalLength * width;
  const pavementVolume = pavementArea * 0.08;
  const railingLength = totalLength * 2;
  const railingConcrete = railingLength * 0.15;
  const expansionJointLength = width * (spanCount + 1);
  const bearingCount = Math.ceil(width / 2.5) * 2 * (spanCount + 1);

  return {
    name: '附属工程',
    pavement: {
      area: Math.round(pavementArea * 10) / 10,
      volume: Math.round(pavementVolume * 10) / 10
    },
    railing: {
      length: Math.round(railingLength * 10) / 10,
      concrete: Math.round(railingConcrete * 10) / 10
    },
    expansionJoint: {
      length: Math.round(expansionJointLength * 10) / 10
    },
    bearings: {
      count: bearingCount
    },
    unit: { area: 'm²', volume: 'm³', length: 'm', count: '个' }
  };
}

function estimateCost(quantities) {
  const unitPrices = {
    concrete: 450,
    rebar: 5000,
    prestress: 8000
  };

  const costs = {
    concrete: Math.round(quantities.concrete * unitPrices.concrete),
    rebar: Math.round(quantities.rebar * unitPrices.rebar),
    prestress: Math.round(quantities.prestress * unitPrices.prestress)
  };

  const total = costs.concrete + costs.rebar + costs.prestress;
  const totalWithOverhead = Math.round(total * 1.5);

  return {
    materialCosts: costs,
    estimatedTotal: totalWithOverhead,
    currency: 'CNY',
    note: '此为估算价格,实际造价以工程量清单为准'
  };
}
