(function installWigForgeMediaPipeWorker(workerScope) {
  let visionPromise = null;
  let segmenterPromise = null;
  let segmenterKey = null;

  workerScope.addEventListener("message", (event) => {
    const payload = event.data || {};
    if (payload.kind !== "segment") {
      return;
    }
    Promise.resolve()
      .then(async () => {
        const vision = await loadVisionBundle(payload.bundleUrl);
        const segmenter = await loadInteractiveSegmenter({
          vision,
          wasmRoot: payload.wasmRoot,
          modelPath: payload.modelPath,
        });
        const canvas = new OffscreenCanvas(payload.width, payload.height);
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Could not create an OffscreenCanvas context for MediaPipe.");
        }
        const imageData = new ImageData(
          new Uint8ClampedArray(payload.imageDataBuffer),
          payload.width,
          payload.height,
        );
        context.putImageData(imageData, 0, 0);

        const result = segmenter.segment(canvas, {
          keypoint: {
            x: clamp(payload.seedX / Math.max(1, payload.width), 0, 1),
            y: clamp(payload.seedY / Math.max(1, payload.height), 0, 1),
          },
        });

        try {
          const confidenceMask = result?.confidenceMasks?.[0];
          if (!confidenceMask) {
            throw new Error("MediaPipe did not return a confidence mask.");
          }
          const confidences = confidenceMask.getAsFloat32Array();
          workerScope.postMessage(
            {
              id: payload.id,
              ok: true,
              width: confidenceMask.width,
              height: confidenceMask.height,
              qualityScore: result?.qualityScores?.[0] ?? null,
              confidencesBuffer: confidences.buffer,
            },
            [confidences.buffer],
          );
        } finally {
          result?.close?.();
        }
      })
      .catch((error) => {
        workerScope.postMessage({
          id: payload.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  async function loadVisionBundle(bundleUrl) {
    if (visionPromise) {
      return visionPromise;
    }
    if (!bundleUrl) {
      throw new Error("Missing MediaPipe bundle URL.");
    }
    visionPromise = import(bundleUrl).catch((error) => {
      visionPromise = null;
      throw error;
    });
    return visionPromise;
  }

  async function loadInteractiveSegmenter(params) {
    const key = `${params.wasmRoot}::${params.modelPath}`;
    if (segmenterPromise && segmenterKey === key) {
      return segmenterPromise;
    }
    segmenterKey = key;
    segmenterPromise = (async () => {
      const fileset = await params.vision.FilesetResolver.forVisionTasks(params.wasmRoot);
      return params.vision.InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: params.modelPath,
          delegate: "CPU",
        },
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    })().catch((error) => {
      segmenterPromise = null;
      segmenterKey = null;
      throw error;
    });
    return segmenterPromise;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
})(self);
