(() => {
  const allowedOrigin = __ORIGIN__;
  if (window !== window.top || location.origin !== allowedOrigin) return;
  const imageBlobs = new Map();
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (value) => {
    const url = createObjectURL(value);
    if (value instanceof Blob && value.type.startsWith("image/")) imageBlobs.set(url, value);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    imageBlobs.delete(url);
    return revokeObjectURL(url);
  };

  function reportError(error) {
    window.alert(`Could not save the image: ${String(error)}`);
  }
  function imageName(title, mimeType) {
    const subtype = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/", 2)[1] || "png";
    const extension = /^[a-z0-9.+-]{1,12}$/i.test(subtype) ? subtype : "png";
    const stem = Array.from(title || "generated-image")
      .map((character) => /[<>:"/\\|?*\x00-\x1f]/.test(character) ? "-" : character)
      .join("")
      .replace(/\.[a-z0-9]{1,10}$/i, "")
      .replace(/[. -]+$/, "")
      .slice(0, 120) || "generated-image";
    return `${stem}.${extension}`;
  }
  function imageBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(reader.error || new Error("Could not read image"));
      reader.readAsDataURL(blob);
    });
  }
  async function save(blob, name) {
    if (!blob.type.startsWith("image/") || blob.size === 0 || blob.size > 32 * 1024 * 1024) {
      throw new Error("Unsupported image or image larger than 32 MiB");
    }
    const internals = window.__TAURI_INTERNALS__;
    const invoke = internals?.invoke?.bind(internals);
    if (typeof invoke !== "function") throw new Error("Native save dialog unavailable");
    await invoke("native_image_save", { fileName: name, bytesBase64: await imageBase64(blob) });
  }
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const blob = this.hasAttribute("download") ? imageBlobs.get(this.href) : undefined;
    if (!blob) return Reflect.apply(originalClick, this, arguments);
    void save(blob, this.download || imageName("generated-image", blob.type)).catch(reportError);
  };

  let menu;
  function closeMenu() {
    menu?.remove();
    menu = undefined;
  }
  async function saveLightboxImage(lightbox, image) {
    const item = lightbox.currentImage || lightbox;
    const resolved = typeof item.loadFullResolution === "function"
      ? await item.loadFullResolution()
      : item;
    const source = resolved?.originalSrc || resolved?.src || image.currentSrc || image.src;
    if (!source) throw new Error("Image source unavailable");
    try {
      const blob = imageBlobs.get(source) || await fetch(source).then((response) => {
        if (!response.ok) throw new Error(`Image request failed (${response.status})`);
        return response.blob();
      });
      await save(blob, imageName(image.alt || item.title || "generated-image", blob.type));
    } finally {
      if (resolved !== item) resolved?.release?.();
    }
  }
  document.addEventListener("contextmenu", (event) => {
    const path = event.composedPath();
    const image = path.find((node) => node instanceof HTMLImageElement && node.classList.contains("image"));
    const lightbox = path.find((node) => node?.localName === "openclaw-image-lightbox");
    if (!image || !lightbox || lightbox.mediaKind === "video") return;
    const container = lightbox.shadowRoot?.querySelector(".lightbox");
    if (!container) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMenu();
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = navigator.language.startsWith("fr") ? "Enregistrer l’image sous…" : "Save image as…";
    button.setAttribute("role", "menuitem");
    button.style.cssText = "display:block;width:100%;padding:8px 16px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit";
    menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.style.cssText = "position:fixed;z-index:2147483647;min-width:210px;padding:4px;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:6px;box-shadow:0 8px 24px #0006";
    menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - 230))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - 50))}px`;
    button.addEventListener("click", () => {
      closeMenu();
      void saveLightboxImage(lightbox, image).catch(reportError);
    });
    menu.append(button);
    container.append(menu);
    button.focus();
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (menu && !event.composedPath().includes(menu)) closeMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu) {
      event.preventDefault();
      closeMenu();
    }
  }, true);
})();
