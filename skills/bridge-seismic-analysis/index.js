/**
 * Bridge Seismic Analysis Skill
 * 按照 JTG/T B02-01-2008 进行抗震分析
 */

export async function execute(action, params) {
  if (action !== 'analyze') {
    return { error: `Unknown action: ${action}` };
  }

  const {
    span = 30,
    pierHeight = 8,
    seismicIntensity = 'VIII',
    siteClass = 'II',
    dampingRatio = 0.05
  } = params;

  const periods = calculatePeriods({ span, pierHeight });
  const spectrum = calculateSpectrum({ seismicIntensity, siteClass, dampingRatio, periods });
  const seismicForces = calculateSeismicForces({ span, spectrum });
  const displacement = calculateDisplacement({ pierHeight, seismicForces });

  return {
    success: true,
    message: '抗震分析完成',
    data: {
      periods,
      spectrum,
      seismicForces,
      displacement,
      checkResult: checkSeismicSafety(displacement)
    },
    reference: 'JTG/T B02-01-2008 公路桥梁抗震设计细则'
  };
}

function calculatePeriods(params) {
  const { span, pierHeight } = params;
  const T1 = 0.05 * Math.pow(span, 0.9);
  const T2 = 0.03 * Math.pow(span, 0.8);
  const T3 = 0.1 * Math.pow(pierHeight, 1.5);
  const T = Math.max(T1, T2, T3);

  return {
    transverse: T1.toFixed(3),
    longitudinal: T2.toFixed(3),
    pierRelated: T3.toFixed(3),
    dominant: T.toFixed(3),
    unit: 's'
  };
}

function calculateSpectrum(params) {
  const { seismicIntensity = 'VIII', siteClass = 'II', dampingRatio = 0.05, periods } = params;

  const A = { 'VI': 0.05, 'VII': 0.10, 'VIII': 0.20, 'IX': 0.40 }[seismicIntensity] || 0.20;
  const Ci = 1.7;
  const Cs = { 'I': 1.2, 'II': 1.0, 'III': 0.9, 'IV': 0.9 }[siteClass] || 1.0;

  let Cd;
  if (dampingRatio === 0.05) Cd = 1.0;
  else Cd = Math.max(0.55, Math.min(1.0, 1.0 + (0.05 - dampingRatio) / (0.06 + 1.7 * dampingRatio)));

  const Tg = { 'I': 0.25, 'II': 0.35, 'III': 0.45, 'IV': 0.65 }[siteClass] || 0.35;
  const T = parseFloat(periods.dominant);

  let S;
  if (T <= Tg) S = 2.25 * Ci * Cs * Cd * A;
  else if (T <= 5 * Tg) S = 2.25 * Ci * Cs * Cd * A * Math.pow(Tg / T, 0.9);
  else S = 2.25 * Ci * Cs * Cd * A * Math.pow(Tg / T, 0.9) * 0.2;

  return {
    peakAcceleration: A,
    importanceFactor: Ci,
    siteFactor: Cs,
    dampingFactor: Cd,
    characteristicPeriod: Tg,
    designSpectrum: S.toFixed(4),
    unit: 'g'
  };
}

function calculateSeismicForces(params) {
  const { span, spectrum } = params;
  const deckWeight = span * 12 * 0.3 * 26;
  const subWeight = 1000;
  const totalWeight = deckWeight + subWeight;
  const Eh = parseFloat(spectrum.designSpectrum) * totalWeight;
  const Ev = 0.5 * Eh;
  const forcePerPier = Eh / 2;

  return {
    totalWeight: Math.round(totalWeight),
    horizontalForce: Math.round(Eh),
    verticalForce: Math.round(Ev),
    forcePerPier: Math.round(forcePerPier),
    unit: 'kN'
  };
}

function calculateDisplacement(params) {
  const { pierHeight, seismicForces } = params;
  const pierStiffness = 50000;
  const force = seismicForces.forcePerPier;
  const displacement = (force / pierStiffness) * 1000;
  const driftRatio = displacement / (pierHeight * 1000);
  const limitDrift = 0.005;

  return {
    displacement: displacement.toFixed(2),
    driftRatio: driftRatio.toFixed(5),
    limitDriftRatio: limitDrift.toFixed(4),
    check: driftRatio <= limitDrift ? 'PASS' : 'FAIL',
    unit: { displacement: 'mm', driftRatio: 'rad/rad' }
  };
}

function checkSeismicSafety(displacement) {
  const checks = [];

  if (displacement.check === 'PASS') {
    checks.push({
      item: 'E1地震位移',
      status: 'PASS',
      message: 'E1地震作用下位移满足规范要求'
    });
  } else {
    checks.push({
      item: 'E1地震位移',
      status: 'FAIL',
      message: 'E1地震作用下位移超限,建议增加墩身刚度或采用减隔震措施'
    });
  }

  checks.push(
    { item: '结构规则性', status: 'REVIEW', message: '请检查桥梁质量和刚度分布是否规则' },
    { item: '落梁防护', status: 'REVIEW', message: '请确认是否设置足够的支座搭接长度或防落梁装置' },
    { item: '液化判别', status: 'REVIEW', message: '请在地质勘察报告中确认是否存在液化土层' }
  );

  return checks;
}
