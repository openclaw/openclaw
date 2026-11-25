// Frozen PGANN structured qualification distribution. Change only with a new preregistration.
export const structuredFixture = Object.freeze({
  version: 1,
  dimensions: 1536,
  latentDimensions: 32,
  clusters: 256,
  seeds: { basis: 0x4f43414e, means: 0x4d45414e, corpus: 0x434f5250, query: 0x51555259 },
  meanStandardDeviation: 1,
  latentStandardDeviation: { first: 0.6, last: 0.15, interpolation: "linear" },
  ambientStandardDeviation: { first: 0.012, last: 0.004, interpolation: "linear" },
  normalize: true,
});

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(seed) {
  const next = random(seed);
  let spare;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(1 - next()));
    const angle = 2 * Math.PI * next();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function drawSeed(seed, index) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

let prepared;
function prepare() {
  if (prepared) {
    return prepared;
  }
  const { dimensions, latentDimensions, clusters, seeds } = structuredFixture;
  const gaussian = normal(seeds.basis);
  const columns = [];
  for (let axis = 0; axis < latentDimensions; axis++) {
    const column = Float64Array.from({ length: dimensions }, () => gaussian());
    // Two modified Gram-Schmidt passes keep the shared basis orthonormal in float64.
    for (let pass = 0; pass < 2; pass++) {
      for (const previous of columns) {
        let dot = 0;
        for (let j = 0; j < dimensions; j++) {
          dot += column[j] * previous[j];
        }
        for (let j = 0; j < dimensions; j++) {
          column[j] -= dot * previous[j];
        }
      }
    }
    let length = 0;
    for (const value of column) {
      length += value * value;
    }
    length = Math.sqrt(length);
    for (let j = 0; j < dimensions; j++) {
      column[j] /= length;
    }
    columns.push(column);
  }
  const basis = new Float64Array(dimensions * latentDimensions);
  for (let j = 0; j < dimensions; j++) {
    for (let axis = 0; axis < latentDimensions; axis++) {
      basis[j * latentDimensions + axis] = columns[axis][j];
    }
  }
  const means = [];
  const meanDraw = normal(seeds.means);
  for (let cluster = 0; cluster < clusters; cluster++) {
    const latent = Float64Array.from({ length: latentDimensions }, () => meanDraw());
    const mean = new Float64Array(dimensions);
    for (let j = 0; j < dimensions; j++) {
      for (let axis = 0; axis < latentDimensions; axis++) {
        mean[j] += latent[axis] * basis[j * latentDimensions + axis];
      }
    }
    means.push(mean);
  }
  prepared = { basis, means };
  return prepared;
}

/** Corpus and query draw streams are independent; queries never copy corpus vectors. */
export function structuredEmbedding(index, stream = "corpus") {
  if (!Number.isSafeInteger(index) || index < 0 || !["corpus", "query"].includes(stream)) {
    throw new Error("Structured fixture requires a nonnegative draw index and corpus/query stream");
  }
  const { basis, means } = prepare();
  const { dimensions, latentDimensions, clusters, seeds } = structuredFixture;
  const seed = drawSeed(seeds[stream], index);
  const cluster = Math.floor(random(seed)() * clusters);
  const gaussian = normal(drawSeed(seed, 0));
  const latent = Float64Array.from(
    { length: latentDimensions },
    (_, axis) => gaussian() * (0.6 - (0.45 * axis) / (latentDimensions - 1)),
  );
  const vector = Array.from({ length: dimensions }, () => 0);
  let squaredNorm = 0;
  for (let j = 0; j < dimensions; j++) {
    let value = means[cluster][j];
    for (let axis = 0; axis < latentDimensions; axis++) {
      value += latent[axis] * basis[j * latentDimensions + axis];
    }
    value += gaussian() * (0.012 - (0.008 * j) / (dimensions - 1));
    vector[j] = value;
    squaredNorm += value * value;
  }
  const length = Math.sqrt(squaredNorm);
  return vector.map((value) => value / length);
}
