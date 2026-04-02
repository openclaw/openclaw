/**
 * Bridge Load Calculation Skill
 * 根据 GB/T 50283-2022《公路桥梁设计通用规范》进行荷载计算
 */

export async function execute(action, params) {
  if (action !== 'calculate') {
    return { error: `Unknown action: ${action}` };
  }

  const {
    type = 'all',
    span = 30,
    width = 12,
    trafficGrade = 'highway-I',
    material = 'concrete',
    bridgeType = 'girder'
  } = params;

  const results = {};

  switch (type) {
    case 'dead':
      results.deadLoad = calculateDeadLoad({ span, width, material });
      break;
    case 'live':
      results.liveLoad = calculateLiveLoad({ span, width, trafficGrade });
      break;
    case 'wind':
      results.windLoad = calculateWindLoad({ span, width });
      break;
    case 'seismic':
      results.seismicLoad = calculateSeismicLoad({ span, width });
      break;
    default:
      results.deadLoad = calculateDeadLoad({ span, width, material });
      results.liveLoad = calculateLiveLoad({ span, width, trafficGrade });
      results.windLoad = calculateWindLoad({ span, width });
      results.seismicLoad = calculateSeismicLoad({ span, width });
  }

  return {
    success: true,
    message: '荷载计算完成',
    data: results,
    reference: 'GB/T 50283-2022 公路桥梁设计通用规范'
  };
}

function calculateDeadLoad(params) {
  const { span, width, material = 'concrete' } = params;
  const unitWeight = material === 'steel' ? 78.5 : 26;
  const sectionArea = span * 0.05;
  const beamWeight = sectionArea * unitWeight;
  const pavementLoad = width * 0.1 * 24;
  const railingLoad = 10;
  const totalDeadLoad = beamWeight + pavementLoad + railingLoad;
  const midMoment = (totalDeadLoad * Math.pow(span, 2)) / 8;

  return {
    beamSelfWeight: beamWeight.toFixed(2),
    pavementLoad: pavementLoad.toFixed(2),
    railingLoad: railingLoad.toFixed(2),
    totalLineLoad: totalDeadLoad.toFixed(2),
    estimatedMidMoment: midMoment.toFixed(2),
    unit: 'kN/m'
  };
}

function calculateLiveLoad(params) {
  const { span, trafficGrade = 'highway-I' } = params;
  let qk, Pk;

  if (trafficGrade === 'highway-I') {
    qk = 10.5;
    if (span <= 5) Pk = 270;
    else if (span >= 50) Pk = 360;
    else Pk = 270 + (360 - 270) * (span - 5) / (50 - 5);
  } else {
    qk = 10.5 * 0.75;
    if (span <= 5) Pk = 270 * 0.75;
    else if (span >= 50) Pk = 360 * 0.75;
    else Pk = (270 + (360 - 270) * (span - 5) / (50 - 5)) * 0.75;
  }

  const momentQk = (qk * Math.pow(span, 2)) / 8;
  const momentPk = (Pk * span) / 4;
  const totalMoment = momentQk + momentPk;
  const reducedMoment = totalMoment * 0.9 * 2;

  return {
    trafficGrade,
    uniformLoad: qk.toFixed(2),
    concentratedLoad: Pk.toFixed(2),
    singleLaneMoment: totalMoment.toFixed(2),
    multiLaneMoment: reducedMoment.toFixed(2),
    unitQk: 'kN/m',
    unitPk: 'kN',
    unitMoment: 'kN·m'
  };
}

function calculateWindLoad(params) {
  const { span, width, height = 2, windPressure = 0.5 } = params;
  const windwardArea = span * (height + 2);
  const windLoad = windPressure * windwardArea;
  const actionPoint = (height + 2) * 2 / 3;

  return {
    windPressure: windPressure.toFixed(2),
    windwardArea: windwardArea.toFixed(2),
    totalWindLoad: windLoad.toFixed(2),
    actionPointHeight: actionPoint.toFixed(2),
    unit: 'kN'
  };
}

function calculateSeismicLoad(params) {
  const { span, width, seismicIntensity = 'VIII' } = params;
  const ci = { 'VI': 0.05, 'VII': 0.10, 'VIII': 0.20, 'IX': 0.40 };
  const importanceFactor = 1.7;
  const Tg = 0.35;
  const T = 0.05 * Math.pow(span, 0.9);
  let S;
  if (T <= Tg) S = 2.25 * ci[seismicIntensity];
  else S = 2.25 * ci[seismicIntensity] * Math.pow(Tg / T, 0.9);
  const weight = span * width * 0.3 * 26;
  const earthquakeForce = importanceFactor * S * weight;

  return {
    seismicIntensity,
    characteristicPeriod: Tg.toFixed(2),
    structurePeriod: T.toFixed(3),
    spectrumValue: S.toFixed(4),
    earthquakeForce: earthquakeForce.toFixed(2),
    unit: 'kN'
  };
}
