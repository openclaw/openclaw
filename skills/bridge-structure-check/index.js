/**
 * Bridge Structure Check Skill
 * 按照 JTG 3362-2018 进行结构验算
 */

export async function execute(action, params) {
  if (action !== 'check') {
    return { error: `Unknown action: ${action}` };
  }

  const {
    type = 'all',
    span = 30,
    width = 2000,
    height = 1500,
    fc = 23.1,
    ft = 1.89,
    fy = 360,
    M = 0,
    V = 0
  } = params;

  let results = {};

  switch (type) {
    case 'strength':
      results = { strength: checkStrength({ span, width, height, fc, ft, fy, M, V }) };
      break;
    case 'stiffness':
      results = { stiffness: checkStiffness({ span, width, height }) };
      break;
    case 'stability':
      results = { stability: checkStability({ span, width, height }) };
      break;
    default:
      results = {
        strength: checkStrength({ span, width, height, fc, ft, fy, M, V }),
        stiffness: checkStiffness({ span, width, height }),
        stability: checkStability({ span, width, height })
      };
  }

  return {
    success: true,
    message: '结构验算完成',
    data: results,
    reference: 'JTG 3362-2018 公路钢筋混凝土及预应力混凝土桥涵设计规范'
  };
}

function checkStrength(params) {
  const { width = 2000, height = 1500, fc = 23.1, fy = 360 } = params;
  const gamma0 = 1.0;
  const fcd = fc;
  const fyd = fy;
  const b = width;
  const h = height;
  const h0 = h - 60;
  const rho = 0.005;
  const As = rho * b * h0;
  const alpha1 = 1.0;
  const Mu = fyd * As * (h0 - 0.5 * fyd * As / (alpha1 * fcd * b));
  const Vcu = 0.45 * Math.pow(10, -3) * b * h0 * Math.pow(1.89, 0.5);

  return {
    section: { width: b, height: h, effectiveHeight: h0 },
    material: { fcd, fyd },
    bendingCapacity: (Mu / Math.pow(10, 6)).toFixed(2),
    shearCapacity: (Vcu / Math.pow(10, 3)).toFixed(2),
    unitBending: 'kN·m',
    unitShear: 'kN'
  };
}

function checkStiffness(params) {
  const { span, width = 2000, height = 1500, E = 34500 } = params;
  const Ic = (width * Math.pow(height, 3)) / 12;
  const Bs = 0.85 * E * Math.pow(10, 3) * Ic;
  const theta = 2.0;
  const Bl = Bs / theta;
  const q = 10;
  const delta = (5 * q * Math.pow(span, 4)) / (384 * (Bl / Math.pow(10, 9)));
  const limit = span * 1000 / 600;

  return {
    momentOfInertia: Ic.toExponential(2),
    shortTermStiffness: Bs.toExponential(2),
    longTermStiffness: Bl.toExponential(2),
    calculatedDeflection: delta.toFixed(2),
    limitDeflection: limit.toFixed(2),
    check: delta <= limit ? 'PASS' : 'FAIL',
    unitDeflection: 'mm'
  };
}

function checkStability(params) {
  const { span, width = 2000, height = 1500, E = 34500 } = params;
  const Iy = (width * Math.pow(height, 3)) / 12;
  const Iz = (height * Math.pow(width, 3)) / 12;
  const A = width * height;
  const iy = Math.sqrt(Iy / A);
  const iz = Math.sqrt(Iz / A);
  const l0 = span * 1000;
  const lambda_y = l0 / iy;
  const lambda_z = l0 / iz;
  const Pcr_y = (Math.pow(Math.PI, 2) * E * Math.pow(10, 3) * Iy) / Math.pow(l0, 2);
  const Pcr_z = (Math.pow(Math.PI, 2) * E * Math.pow(10, 3) * Iz) / Math.pow(l0, 2);

  return {
    momentOfInertia: { Iy: Iy.toExponential(2), Iz: Iz.toExponential(2) },
    radiusOfGyration: { iy: iy.toFixed(2), iz: iz.toFixed(2) },
    slendernessRatio: { lambda_y: lambda_y.toFixed(1), lambda_z: lambda_z.toFixed(1) },
    eulerCriticalForce: {
      Pcr_y: (Pcr_y / Math.pow(10, 3)).toFixed(2),
      Pcr_z: (Pcr_z / Math.pow(10, 3)).toFixed(2)
    },
    check: lambda_y <= 200 && lambda_z <= 200 ? 'PASS' : 'REVIEW',
    unitForce: 'kN'
  };
}
