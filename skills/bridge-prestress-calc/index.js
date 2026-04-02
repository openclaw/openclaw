/**
 * Bridge Prestress Calculation Skill
 * 预应力混凝土桥梁计算
 */

export async function execute(action, params) {
  if (action !== 'calculate') {
    return { error: `Unknown action: ${action}` };
  }

  const {
    span = 30,
    tendonType = '15.2',
    initialTension = 1395,
    tendonArea = 0.005
  } = params;

  const losses = calculatePrestressLosses({ initialTension, tendonArea, span });
  const effectivePrestress = calculateEffectivePrestress({ initialTension, tendonArea, losses });
  const stressCheck = checkStress({ span, effectivePrestress });

  return {
    success: true,
    message: '预应力计算完成',
    data: {
      losses,
      effectivePrestress,
      stressCheck
    },
    reference: 'JTG 3362-2018 公路钢筋混凝土及预应力混凝土桥涵设计规范'
  };
}

function calculatePrestressLosses(params) {
  const { initialTension = 1395, tendonArea = 0.005, span } = params;
  const fcon = initialTension;
  const Ap = tendonArea * 1000000;
  const Es = 195000;
  const L = span * 1000;

  const deltaL = 6;
  const sigmaL1 = (deltaL / L) * Es;

  const theta = 0.3;
  const k = 0.0015;
  const mu = 0.25;
  const sigmaL2 = fcon * (1 - Math.exp(-(mu * theta + k * L)));

  const deltaT = 20;
  const sigmaL3 = 2 * deltaT;

  const alpha = 0.5;
  const sigmaPc = 10;
  const sigmaL4 = alpha * sigmaPc;

  const sigmaL5 = 50;
  const sigmaL6 = 40;
  const rho = 0.035;
  const sigmaL7 = rho * fcon;

  const lossStage1 = sigmaL1 + sigmaL2 + sigmaL3 + 0.5 * sigmaL4;
  const lossStage2 = 0.5 * sigmaL4 + sigmaL5 + sigmaL6 + sigmaL7;
  const totalLoss = lossStage1 + lossStage2;
  const lossRatio = totalLoss / fcon;

  return {
    anchorSet: Math.round(sigmaL1),
    friction: Math.round(sigmaL2),
    temperature: Math.round(sigmaL3),
    elasticShortening: Math.round(sigmaL4),
    creep: Math.round(sigmaL5),
    shrinkage: Math.round(sigmaL6),
    relaxation: Math.round(sigmaL7),
    stage1: Math.round(lossStage1),
    stage2: Math.round(lossStage2),
    total: Math.round(totalLoss),
    ratio: (lossRatio * 100).toFixed(1),
    unit: 'MPa',
    ratioUnit: '%'
  };
}

function calculateEffectivePrestress(params) {
  const { initialTension = 1395, tendonArea = 0.005, losses } = params;
  const fcon = initialTension;
  const sigmaPe = fcon - losses.total;
  const Ap = tendonArea * 1000000;
  const Pe = sigmaPe * Ap / 1000;
  const A = 5 * Math.pow(10, 6);
  const sigmaPc = Pe * 1000 / A;

  return {
    initialStress: fcon,
    effectiveStress: sigmaPe,
    effectiveForce: Math.round(Pe),
    concreteCompressiveStress: sigmaPc.toFixed(2),
    unit: { stress: 'MPa', force: 'kN' }
  };
}

function checkStress(params) {
  const { span, effectivePrestress } = params;
  const I = 2.5 * Math.pow(10, 12);
  const y = 800;
  const W = I / y;
  const q = 30;
  const M = (q * Math.pow(span, 2)) / 8 * Math.pow(10, 6);
  const sigmaM = M / W;
  const sigmaCc = effectivePrestress.concreteCompressiveStress;
  const sigmaCt = sigmaM - sigmaCc;
  const fck = 50;
  const ftk = 2.64;
  const fckAllow = 0.5 * fck;

  return {
    loadStress: sigmaM.toFixed(2),
    prestressStress: sigmaCc,
    combinedStress: sigmaCt.toFixed(2),
    compressiveCheck: sigmaCc <= fckAllow ? 'PASS' : 'FAIL',
    tensileCheck: sigmaCt <= ftk ? 'PASS' : 'REVIEW',
    limits: {
      maxCompression: fckAllow,
      maxTension: ftk
    },
    unit: 'MPa'
  };
}
