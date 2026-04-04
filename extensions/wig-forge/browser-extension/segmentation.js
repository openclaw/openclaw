(function installWigForgeSegmentation(globalScope) {
  const MEDIAPIPE_BUNDLE_PATH = "vendor/mediapipe/vision_bundle.mjs";
  const MEDIAPIPE_WASM_DIR = "vendor/mediapipe/wasm/";
  const MEDIAPIPE_MODEL_PATH = "vendor/models/magic_touch.tflite";
  const MEDIAPIPE_WORKER_PATH = "mediapipe-worker.js";
  const DEFAULT_MASK_PADDING = 4;
  const MEDIAPIPE_TIMEOUT_MS = 5000;

  let mediaPipeWorker = null;
  let mediaPipeWorkerPromise = null;
  let mediaPipeWorkerBlobUrl = null;
  let mediaPipeRequestId = 0;
  const mediaPipePendingRequests = new Map();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function colorDistance(a, b) {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function readPixel(data, index) {
    return {
      r: data[index],
      g: data[index + 1],
      b: data[index + 2],
      a: data[index + 3],
    };
  }

  function sampleSeedColor(params) {
    const { data, width, height, seedX, seedY } = params;
    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let totalA = 0;
    let count = 0;
    const samples = [];

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const x = clamp(seedX + offsetX, 0, width - 1);
        const y = clamp(seedY + offsetY, 0, height - 1);
        const index = (y * width + x) * 4;
        const pixel = readPixel(data, index);
        totalR += pixel.r;
        totalG += pixel.g;
        totalB += pixel.b;
        totalA += pixel.a;
        samples.push(pixel);
        count += 1;
      }
    }

    const average = {
      r: totalR / count,
      g: totalG / count,
      b: totalB / count,
      a: totalA / count,
    };
    const variance =
      samples.reduce((sum, sample) => sum + colorDistance(sample, average), 0) /
      Math.max(1, samples.length);

    return { average, variance };
  }

  function segmentPixelBuffer(params) {
    const { data, width, height } = params;
    const seedX = clamp(Math.round(params.seedX), 0, width - 1);
    const seedY = clamp(Math.round(params.seedY), 0, height - 1);
    const seedInfo = sampleSeedColor({ data, width, height, seedX, seedY });
    const seed = seedInfo.average;
    const globalThreshold = clamp(26 + seedInfo.variance * 1.8, 24, 78);
    const localThreshold = globalThreshold * 0.72;
    const relaxedSeedThreshold = globalThreshold * 1.28;

    const visited = new Uint8Array(width * height);
    const mask = new Uint8Array(width * height);
    const queue = new Uint32Array(width * height);
    let queueStart = 0;
    let queueEnd = 0;
    const seedIndex = seedY * width + seedX;
    queue[queueEnd++] = seedIndex;
    visited[seedIndex] = 1;

    let minX = seedX;
    let minY = seedY;
    let maxX = seedX;
    let maxY = seedY;
    let area = 0;

    while (queueStart < queueEnd) {
      const pointIndex = queue[queueStart++];
      const x = pointIndex % width;
      const y = Math.floor(pointIndex / width);
      const rgbaIndex = pointIndex * 4;
      const current = readPixel(data, rgbaIndex);

      if (current.a < 8) {
        continue;
      }

      mask[pointIndex] = 1;
      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      const neighbors = [pointIndex - width, pointIndex + width, pointIndex - 1, pointIndex + 1];

      for (let i = 0; i < neighbors.length; i += 1) {
        const neighborIndex = neighbors[i];
        if (neighborIndex < 0 || neighborIndex >= width * height || visited[neighborIndex]) {
          continue;
        }
        const nx = neighborIndex % width;
        const ny = Math.floor(neighborIndex / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) {
          continue;
        }
        visited[neighborIndex] = 1;
        const neighborRgbaIndex = neighborIndex * 4;
        const neighbor = readPixel(data, neighborRgbaIndex);
        if (neighbor.a < 8) {
          continue;
        }
        const seedDiff = colorDistance(neighbor, seed);
        const localDiff = colorDistance(neighbor, current);
        if (
          seedDiff <= globalThreshold ||
          (seedDiff <= relaxedSeedThreshold && localDiff <= localThreshold)
        ) {
          queue[queueEnd++] = neighborIndex;
        }
      }
    }

    if (area < 9) {
      return {
        ok: false,
        reason: "mask_too_small",
        confidence: 0,
      };
    }

    growMask({ data, width, height, mask, seed, relaxedSeedThreshold: relaxedSeedThreshold + 10 });
    const finalBounds = computeBounds(mask, width, height);
    const coverage = finalBounds.area / Math.max(1, width * height);
    const confidence = clamp(
      0.38 +
        Math.min(0.28, coverage * 0.9) +
        Math.min(0.16, seedInfo.variance / 90) -
        (coverage > 0.9 ? 0.26 : 0),
      0.16,
      0.92,
    );

    return {
      ok: true,
      mask,
      bounds: finalBounds,
      coverage,
      confidence,
      threshold: globalThreshold,
    };
  }

  function growMask(params) {
    const { data, width, height, mask, seed, relaxedSeedThreshold } = params;
    const additions = [];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (mask[index]) {
          continue;
        }
        let neighbors = 0;
        const around = [
          index - width,
          index + width,
          index - 1,
          index + 1,
          index - width - 1,
          index - width + 1,
          index + width - 1,
          index + width + 1,
        ];
        for (let i = 0; i < around.length; i += 1) {
          if (mask[around[i]]) {
            neighbors += 1;
          }
        }
        if (neighbors < 4) {
          continue;
        }
        const rgbaIndex = index * 4;
        const pixel = readPixel(data, rgbaIndex);
        if (pixel.a < 8) {
          continue;
        }
        if (colorDistance(pixel, seed) <= relaxedSeedThreshold) {
          additions.push(index);
        }
      }
    }
    for (let i = 0; i < additions.length; i += 1) {
      mask[additions[i]] = 1;
    }
  }

  function computeBounds(mask, width, height) {
    let minX = width - 1;
    let minY = height - 1;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!mask[index]) {
          continue;
        }
        area += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      area,
    };
  }

  function computeAlphaBounds(alphaMap, width, height, threshold = 0.035) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let area = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if ((alphaMap[index] ?? 0) < threshold) {
          continue;
        }
        area += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX || maxY < minY) {
      return null;
    }

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      area,
    };
  }

  function maxFilterFloatMap(source, width, height, radius = 1) {
    const output = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let value = 0;
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          const sampleY = clamp(y + offsetY, 0, height - 1);
          for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
            const sampleX = clamp(x + offsetX, 0, width - 1);
            value = Math.max(value, source[sampleY * width + sampleX] ?? 0);
          }
        }
        output[y * width + x] = value;
      }
    }
    return output;
  }

  function minFilterFloatMap(source, width, height, radius = 1) {
    const output = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let value = 1;
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          const sampleY = clamp(y + offsetY, 0, height - 1);
          for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
            const sampleX = clamp(x + offsetX, 0, width - 1);
            value = Math.min(value, source[sampleY * width + sampleX] ?? 0);
          }
        }
        output[y * width + x] = value;
      }
    }
    return output;
  }

  function blurFloatMap(source, width, height, radius = 1) {
    const horizontal = new Float32Array(source.length);
    const output = new Float32Array(source.length);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let total = 0;
        let count = 0;
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = clamp(x + offsetX, 0, width - 1);
          total += source[y * width + sampleX] ?? 0;
          count += 1;
        }
        horizontal[y * width + x] = total / Math.max(1, count);
      }
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let total = 0;
        let count = 0;
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          const sampleY = clamp(y + offsetY, 0, height - 1);
          total += horizontal[sampleY * width + x] ?? 0;
          count += 1;
        }
        output[y * width + x] = total / Math.max(1, count);
      }
    }

    return output;
  }

  function refineAlphaMap(alphaMap, width, height) {
    const closed = minFilterFloatMap(
      maxFilterFloatMap(alphaMap, width, height, 1),
      width,
      height,
      1,
    );
    const opened = maxFilterFloatMap(minFilterFloatMap(closed, width, height, 1), width, height, 1);
    const blurred = blurFloatMap(opened, width, height, 1);
    const output = new Float32Array(alphaMap.length);

    for (let index = 0; index < alphaMap.length; index += 1) {
      const base = Math.max(alphaMap[index] ?? 0, (opened[index] ?? 0) * 0.92);
      let refined = clamp(blurred[index] * 0.72 + base * 0.48, 0, 1);
      if (base >= 0.96) {
        refined = Math.max(refined, base);
      }
      if (refined <= 0.03) {
        refined = 0;
      } else if (refined >= 0.985) {
        refined = 1;
      } else {
        refined = Math.pow(refined, 0.92);
      }
      output[index] = clamp(refined, 0, 1);
    }

    return output;
  }

  function buildAlphaMapFromBinaryMask(mask) {
    const alphaMap = new Float32Array(mask.length);
    for (let index = 0; index < mask.length; index += 1) {
      alphaMap[index] = mask[index] ? 1 : 0;
    }
    return alphaMap;
  }

  function buildAlphaMapFromConfidences(confidences, threshold) {
    const alphaMap = new Float32Array(confidences.length);
    for (let index = 0; index < confidences.length; index += 1) {
      const value = confidences[index] ?? 0;
      if (value <= threshold) {
        alphaMap[index] = 0;
        continue;
      }
      const normalized = (value - threshold) / Math.max(0.0001, 1 - threshold);
      alphaMap[index] = clamp(Math.pow(normalized, 0.68), 0, 1);
    }
    return alphaMap;
  }

  function decontaminateEdgePixels(data, width, height) {
    const original = new Uint8ClampedArray(data);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const alpha = original[index + 3];
        if (alpha <= 0 || alpha >= 252) {
          continue;
        }

        let totalR = 0;
        let totalG = 0;
        let totalB = 0;
        let totalWeight = 0;

        for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
          const sampleY = clamp(y + offsetY, 0, height - 1);
          for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
            const sampleX = clamp(x + offsetX, 0, width - 1);
            const sampleIndex = (sampleY * width + sampleX) * 4;
            const sampleAlpha = original[sampleIndex + 3];
            if (sampleAlpha < 220) {
              continue;
            }
            const distance = Math.max(1, Math.abs(offsetX) + Math.abs(offsetY));
            const weight = (sampleAlpha / 255) * (1 / distance);
            totalR += original[sampleIndex] * weight;
            totalG += original[sampleIndex + 1] * weight;
            totalB += original[sampleIndex + 2] * weight;
            totalWeight += weight;
          }
        }

        if (totalWeight <= 0) {
          continue;
        }

        const blend = Math.pow(1 - alpha / 255, 0.72) * 0.82;
        const foregroundR = totalR / totalWeight;
        const foregroundG = totalG / totalWeight;
        const foregroundB = totalB / totalWeight;
        data[index] = Math.round(original[index] * (1 - blend) + foregroundR * blend);
        data[index + 1] = Math.round(original[index + 1] * (1 - blend) + foregroundG * blend);
        data[index + 2] = Math.round(original[index + 2] * (1 - blend) + foregroundB * blend);
      }
    }
  }

  function getExtensionApi() {
    return globalScope.browser ?? globalScope.chrome;
  }

  function getExtensionAssetUrl(relativePath) {
    const ext = getExtensionApi();
    if (!ext?.runtime?.getURL) {
      return null;
    }
    return ext.runtime.getURL(relativePath);
  }

  function terminateMediaPipeWorker() {
    if (mediaPipeWorker) {
      mediaPipeWorker.terminate();
      mediaPipeWorker = null;
    }
    if (mediaPipeWorkerBlobUrl && globalScope.URL?.revokeObjectURL) {
      globalScope.URL.revokeObjectURL(mediaPipeWorkerBlobUrl);
      mediaPipeWorkerBlobUrl = null;
    }
    mediaPipeWorkerPromise = null;
    const pending = Array.from(mediaPipePendingRequests.values());
    mediaPipePendingRequests.clear();
    for (let i = 0; i < pending.length; i += 1) {
      pending[i].reject(new Error("MediaPipe worker terminated before replying."));
    }
  }

  async function getMediaPipeWorker() {
    if (mediaPipeWorker) {
      return mediaPipeWorker;
    }
    if (mediaPipeWorkerPromise) {
      return mediaPipeWorkerPromise;
    }
    mediaPipeWorkerPromise = (async () => {
      if (typeof globalScope.Worker !== "function") {
        throw new Error("web workers are unavailable");
      }
      const workerUrl = getExtensionAssetUrl(MEDIAPIPE_WORKER_PATH);
      if (!workerUrl) {
        throw new Error("mediapipe worker asset unavailable");
      }
      const response = await fetch(workerUrl);
      if (!response.ok) {
        throw new Error(`Could not load MediaPipe worker bootstrap (${response.status}).`);
      }
      const workerSource = await response.text();
      mediaPipeWorkerBlobUrl = globalScope.URL.createObjectURL(
        new Blob([workerSource], { type: "text/javascript" }),
      );
      mediaPipeWorker = new globalScope.Worker(mediaPipeWorkerBlobUrl);
      mediaPipeWorker.addEventListener("message", (event) => {
        const payload = event.data || {};
        const pending = mediaPipePendingRequests.get(payload.id);
        if (!pending) {
          return;
        }
        mediaPipePendingRequests.delete(payload.id);
        if (payload.ok) {
          pending.resolve(payload);
          return;
        }
        pending.reject(new Error(payload.error || "MediaPipe worker request failed."));
      });
      mediaPipeWorker.addEventListener("error", (event) => {
        const message =
          typeof event?.message === "string" && event.message
            ? event.message
            : "MediaPipe worker crashed.";
        terminateMediaPipeWorker();
        console.warn("Wig Forge MediaPipe worker crashed.", message);
      });
      return mediaPipeWorker;
    })().catch((error) => {
      mediaPipeWorkerPromise = null;
      throw error;
    });
    return mediaPipeWorkerPromise;
  }

  async function requestMediaPipeMask(params) {
    const worker = await getMediaPipeWorker();
    const bundleUrl = getExtensionAssetUrl(MEDIAPIPE_BUNDLE_PATH);
    const wasmRoot = getExtensionAssetUrl(MEDIAPIPE_WASM_DIR);
    const modelPath = getExtensionAssetUrl(MEDIAPIPE_MODEL_PATH);
    if (!bundleUrl || !wasmRoot || !modelPath) {
      throw new Error("mediapipe assets unavailable");
    }
    const requestId = ++mediaPipeRequestId;
    const pixelCopy = new Uint8ClampedArray(params.imageData.data);
    const responsePromise = new Promise((resolve, reject) => {
      mediaPipePendingRequests.set(requestId, { resolve, reject });
    });
    worker.postMessage(
      {
        kind: "segment",
        id: requestId,
        bundleUrl,
        wasmRoot,
        modelPath,
        imageDataBuffer: pixelCopy.buffer,
        width: params.cropWidth,
        height: params.cropHeight,
        seedX: params.seedX,
        seedY: params.seedY,
      },
      [pixelCopy.buffer],
    );
    return await new Promise((resolve, reject) => {
      const timeoutId = globalScope.setTimeout(() => {
        mediaPipePendingRequests.delete(requestId);
        reject(new Error(`MediaPipe mask request timed out after ${MEDIAPIPE_TIMEOUT_MS}ms.`));
      }, MEDIAPIPE_TIMEOUT_MS);

      responsePromise
        .then((value) => {
          globalScope.clearTimeout(timeoutId);
          resolve(value);
        })
        .catch((error) => {
          globalScope.clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  function segmentConfidenceMask(params) {
    const { confidences, width, height } = params;
    const seedX = clamp(Math.round(params.seedX), 0, width - 1);
    const seedY = clamp(Math.round(params.seedY), 0, height - 1);
    const qualityScore = clamp(
      typeof params.qualityScore === "number" ? params.qualityScore : 0.88,
      0,
      1,
    );
    const seedIndex = seedY * width + seedX;
    const seedConfidence = confidences[seedIndex] ?? 0;
    if (seedConfidence < 0.08) {
      return {
        ok: false,
        reason: "seed_confidence_too_low",
        confidence: 0,
        seedConfidence,
      };
    }

    const threshold = clamp(Math.max(0.18, seedConfidence * 0.52), 0.18, 0.84);
    const visited = new Uint8Array(width * height);
    const mask = new Uint8Array(width * height);
    const queue = new Uint32Array(width * height);
    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd++] = seedIndex;
    visited[seedIndex] = 1;

    let area = 0;
    let confidenceTotal = 0;

    while (queueStart < queueEnd) {
      const pointIndex = queue[queueStart++];
      const value = confidences[pointIndex] ?? 0;
      if (value < threshold) {
        continue;
      }
      mask[pointIndex] = 1;
      area += 1;
      confidenceTotal += value;

      const x = pointIndex % width;
      const y = Math.floor(pointIndex / width);
      const neighbors = [pointIndex - width, pointIndex + width, pointIndex - 1, pointIndex + 1];
      for (let i = 0; i < neighbors.length; i += 1) {
        const neighborIndex = neighbors[i];
        if (neighborIndex < 0 || neighborIndex >= width * height || visited[neighborIndex]) {
          continue;
        }
        const nx = neighborIndex % width;
        const ny = Math.floor(neighborIndex / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) {
          continue;
        }
        visited[neighborIndex] = 1;
        if ((confidences[neighborIndex] ?? 0) >= threshold) {
          queue[queueEnd++] = neighborIndex;
        }
      }
    }

    if (area < 9) {
      return {
        ok: false,
        reason: "mask_too_small",
        confidence: 0,
        seedConfidence,
        threshold,
      };
    }

    const bounds = computeBounds(mask, width, height);
    const coverage = bounds.area / Math.max(1, width * height);
    const averageConfidence = confidenceTotal / Math.max(1, area);
    const confidence = clamp(
      0.4 +
        averageConfidence * 0.3 +
        qualityScore * 0.18 +
        seedConfidence * 0.12 -
        (coverage > 0.92 ? 0.28 : 0),
      0.18,
      0.99,
    );

    return {
      ok: true,
      mask,
      bounds,
      coverage,
      confidence,
      threshold,
      seedConfidence,
      averageConfidence,
    };
  }

  function expandBounds(bounds, width, height, padding = DEFAULT_MASK_PADDING) {
    const minX = clamp(bounds.minX - padding, 0, width - 1);
    const minY = clamp(bounds.minY - padding, 0, height - 1);
    const maxX = clamp(bounds.maxX + padding, 0, width - 1);
    const maxY = clamp(bounds.maxY + padding, 0, height - 1);
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }

  function renderMaskedCutout(params) {
    const { imageData, width, height } = params;
    const alphaMap =
      params.alphaMap || maskToAlphaMapFallback(params.mask, params.alphaForIndex, width, height);
    const contentBounds = computeAlphaBounds(alphaMap, width, height, 0.035) || params.bounds;
    const outputBounds = expandBounds(contentBounds, width, height, params.padding);
    const output = document.createElement("canvas");
    output.width = outputBounds.width;
    output.height = outputBounds.height;
    const outputContext = output.getContext("2d");
    const result = outputContext.createImageData(outputBounds.width, outputBounds.height);

    for (let y = outputBounds.minY; y <= outputBounds.maxY; y += 1) {
      for (let x = outputBounds.minX; x <= outputBounds.maxX; x += 1) {
        const sourceIndex = y * width + x;
        const targetIndex =
          ((y - outputBounds.minY) * outputBounds.width + (x - outputBounds.minX)) * 4;
        const alphaWeight = clamp(alphaMap[sourceIndex] ?? 0, 0, 1);
        if (alphaWeight <= 0.001) {
          result.data[targetIndex + 3] = 0;
          continue;
        }
        const sourceRgbaIndex = sourceIndex * 4;
        result.data[targetIndex] = imageData.data[sourceRgbaIndex];
        result.data[targetIndex + 1] = imageData.data[sourceRgbaIndex + 1];
        result.data[targetIndex + 2] = imageData.data[sourceRgbaIndex + 2];
        result.data[targetIndex + 3] = Math.round(
          imageData.data[sourceRgbaIndex + 3] * alphaWeight,
        );
      }
    }

    decontaminateEdgePixels(result.data, outputBounds.width, outputBounds.height);
    outputContext.putImageData(result, 0, 0);
    return {
      dataUrl: output.toDataURL("image/png"),
      bounds: {
        x: outputBounds.minX,
        y: outputBounds.minY,
        width: outputBounds.width,
        height: outputBounds.height,
      },
    };
  }

  function maskToAlphaMapFallback(mask, alphaForIndex, width, height) {
    const alphaMap = new Float32Array(width * height);
    for (let index = 0; index < width * height; index += 1) {
      if (typeof alphaForIndex === "function") {
        alphaMap[index] = clamp(alphaForIndex(index), 0, 1);
      } else {
        alphaMap[index] = mask?.[index] ? 1 : 0;
      }
    }
    return alphaMap;
  }

  async function extractMediaPipeCutout(params) {
    const response = await requestMediaPipeMask(params);
    const confidences = new Float32Array(response.confidencesBuffer);
    const segmented = segmentConfidenceMask({
      confidences,
      width: response.width,
      height: response.height,
      seedX: params.seedX,
      seedY: params.seedY,
      qualityScore: response.qualityScore,
    });
    if (!segmented.ok || !segmented.bounds) {
      return null;
    }
    const alphaMap = refineAlphaMap(
      buildAlphaMapFromConfidences(confidences, segmented.threshold),
      params.cropWidth,
      params.cropHeight,
    );
    const cutout = renderMaskedCutout({
      imageData: params.imageData,
      width: params.cropWidth,
      height: params.cropHeight,
      alphaMap,
      bounds:
        computeAlphaBounds(alphaMap, params.cropWidth, params.cropHeight, 0.035) ||
        segmented.bounds,
      padding: DEFAULT_MASK_PADDING,
    });
    return {
      mode: "mediapipe-interactive",
      dataUrl: cutout.dataUrl,
      diagnostics: {
        confidence: segmented.confidence,
        coverage: segmented.coverage,
        matteCoverage:
          (computeAlphaBounds(alphaMap, params.cropWidth, params.cropHeight, 0.035)?.area || 0) /
          Math.max(1, params.cropWidth * params.cropHeight),
        threshold: segmented.threshold,
        seedConfidence: segmented.seedConfidence,
        averageConfidence: segmented.averageConfidence,
        qualityScore: response.qualityScore ?? null,
        bounds: cutout.bounds,
        cropWidth: params.cropWidth,
        cropHeight: params.cropHeight,
      },
    };
  }

  function extractHeuristicCutout(params) {
    const segmented = segmentPixelBuffer({
      data: params.imageData.data,
      width: params.cropWidth,
      height: params.cropHeight,
      seedX: params.seedX,
      seedY: params.seedY,
    });

    if (!segmented.ok || !segmented.bounds) {
      return {
        mode: "rect-fallback",
        dataUrl: params.canvas.toDataURL("image/png"),
        diagnostics: {
          confidence: 0,
          reason: segmented.reason || "segmentation_failed",
          cropWidth: params.cropWidth,
          cropHeight: params.cropHeight,
        },
      };
    }

    const alphaMap = refineAlphaMap(
      buildAlphaMapFromBinaryMask(segmented.mask),
      params.cropWidth,
      params.cropHeight,
    );
    const cutout = renderMaskedCutout({
      imageData: params.imageData,
      width: params.cropWidth,
      height: params.cropHeight,
      alphaMap,
      bounds:
        computeAlphaBounds(alphaMap, params.cropWidth, params.cropHeight, 0.035) ||
        segmented.bounds,
      padding: DEFAULT_MASK_PADDING,
    });

    return {
      mode: "point-segmentation",
      dataUrl: cutout.dataUrl,
      diagnostics: {
        confidence: segmented.confidence,
        coverage: segmented.coverage,
        matteCoverage:
          (computeAlphaBounds(alphaMap, params.cropWidth, params.cropHeight, 0.035)?.area || 0) /
          Math.max(1, params.cropWidth * params.cropHeight),
        bounds: cutout.bounds,
        cropWidth: params.cropWidth,
        cropHeight: params.cropHeight,
      },
    };
  }

  async function extractCutoutFromDataUrl(params) {
    const image = await loadImage(params.dataUrl);
    const canvas = document.createElement("canvas");
    const cropWidth = Math.max(1, Math.round(params.rect.width * params.devicePixelRatio));
    const cropHeight = Math.max(1, Math.round(params.rect.height * params.devicePixelRatio));
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a canvas context for capture.");
    }
    context.drawImage(
      image,
      Math.round(params.rect.left * params.devicePixelRatio),
      Math.round(params.rect.top * params.devicePixelRatio),
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );

    const imageData = context.getImageData(0, 0, cropWidth, cropHeight);
    const seedX = clamp(
      Math.round((params.clickPoint.x - params.rect.left) * params.devicePixelRatio),
      0,
      cropWidth - 1,
    );
    const seedY = clamp(
      Math.round((params.clickPoint.y - params.rect.top) * params.devicePixelRatio),
      0,
      cropHeight - 1,
    );

    try {
      const mediaPipeCutout = await extractMediaPipeCutout({
        canvas,
        imageData,
        cropWidth,
        cropHeight,
        seedX,
        seedY,
      });
      if (mediaPipeCutout) {
        return mediaPipeCutout;
      }
    } catch (error) {
      console.warn(
        "Wig Forge MediaPipe segmentation failed, falling back to heuristic mask.",
        error,
      );
    }

    return extractHeuristicCutout({
      canvas,
      imageData,
      cropWidth,
      cropHeight,
      seedX,
      seedY,
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode screenshot capture."));
      image.src = src;
    });
  }

  const api = {
    segmentPixelBuffer,
    segmentConfidenceMask,
    extractCutoutFromDataUrl,
  };
  globalScope.WigForgeSegmentation = api;
})(globalThis);
