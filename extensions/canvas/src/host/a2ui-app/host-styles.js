const isAndroid = /Android/i.test(globalThis.navigator?.userAgent ?? "");
const statusBlur = isAndroid ? "10px" : "14px";
const statusShadow = isAndroid
  ? "0 2px 10px rgba(0, 0, 0, 0.18)"
  : "0 10px 24px rgba(0, 0, 0, 0.25)";
export const hostStyles = `
    openclaw-a2ui-host {
      display: block;
      height: 100%;
      position: relative;
      box-sizing: border-box;
      padding: var(--openclaw-a2ui-inset-top, 0px) var(--openclaw-a2ui-inset-right, 0px)
        var(--openclaw-a2ui-inset-bottom, 0px) var(--openclaw-a2ui-inset-left, 0px);
    }

    openclaw-a2ui-host #surfaces {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      height: 100%;
      overflow: auto;
      padding-bottom: var(--openclaw-a2ui-scroll-pad-bottom, 0px);
    }

    openclaw-a2ui-host .status {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--openclaw-a2ui-status-top, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font:
        13px/1.2 system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Roboto",
        sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${statusBlur});
      -webkit-backdrop-filter: blur(${statusBlur});
      box-shadow: ${statusShadow};
      z-index: 5;
    }

    openclaw-a2ui-host .toast {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: var(--openclaw-a2ui-toast-bottom, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font:
        13px/1.2 system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Roboto",
        sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${statusBlur});
      -webkit-backdrop-filter: blur(${statusBlur});
      box-shadow: ${statusShadow};
      z-index: 5;
    }

    openclaw-a2ui-host .toast.error {
      border-color: rgba(255, 109, 109, 0.35);
      color: rgba(255, 223, 223, 0.98);
    }

    openclaw-a2ui-host .empty {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--openclaw-a2ui-empty-top, var(--openclaw-a2ui-status-top, 12px));
      text-align: center;
      opacity: 0.8;
      padding: 10px 12px;
      pointer-events: none;
    }

    openclaw-a2ui-host .empty-title {
      font-weight: 700;
      margin-bottom: 6px;
    }

    openclaw-a2ui-host .spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.25);
      border-top-color: rgba(255, 255, 255, 0.92);
      animation: spin 0.75s linear infinite;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;
