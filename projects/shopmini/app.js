(() => {
  "use strict";

  const STORAGE_KEY = "shopmini-mvp-v1";
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => new Intl.NumberFormat("vi-VN", {
    style: "currency", currency: "VND", maximumFractionDigits: 0
  }).format(Number(value) || 0);
  const safeText = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const makeId = () => "DH" + Date.now().toString().slice(-8);

  const starterData = {
    products: [
      { id: "SP01", name: "Bình giữ nhiệt", price: 129000, stock: 18, emoji: "🥤" },
      { id: "SP02", name: "Túi tote canvas", price: 89000, stock: 24, emoji: "👜" },
      { id: "SP03", name: "Đèn bàn mini", price: 159000, stock: 9, emoji: "💡" }
    ],
    orders: [
      { id: "DH240101", customer: "Nguyễn Minh Anh", productId: "SP01", productName: "Bình giữ nhiệt", quantity: 2, unitPrice: 129000, status: "Đã giao", createdAt: "Hôm nay" },
      { id: "DH240102", customer: "Trần Gia Huy", productId: "SP03", productName: "Đèn bàn mini", quantity: 1, unitPrice: 159000, status: "Đang giao", createdAt: "Hôm nay" },
      { id: "DH240103", customer: "Lê Thu Hà", productId: "SP02", productName: "Túi tote canvas", quantity: 3, unitPrice: 89000, status: "Mới", createdAt: "Hôm nay" }
    ]
  };

  let state;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    state = saved && Array.isArray(saved.products) && Array.isArray(saved.orders) ? saved : structuredClone(starterData);
  } catch {
    state = JSON.parse(JSON.stringify(starterData));
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      notify("Không thể lưu dữ liệu trên trình duyệt này.");
    }
  }

  let toastTimer;
  function notify(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function getProduct(id) {
    return state.products.find((product) => product.id === id);
  }

  function renderStats() {
    const revenue = state.orders
      .filter((order) => order.status === "Đã giao")
      .reduce((sum, order) => sum + order.unitPrice * order.quantity, 0);
    $("#stat-revenue").textContent = money(revenue);
    $("#stat-orders").textContent = state.orders.length;
    $("#stat-pending").textContent = state.orders.filter((order) => ["Mới", "Đang giao"].includes(order.status)).length;
    $("#stat-products").textContent = state.products.length;
    $("#product-count-label").textContent = state.products.length + " sản phẩm";
  }

  function renderProducts() {
    const list = $("#product-list");
    if (!state.products.length) {
      list.innerHTML = '<div class="empty-state"><strong>Chưa có sản phẩm</strong><p>Thêm sản phẩm ở biểu mẫu phía trên.</p></div>';
    } else {
      list.innerHTML = state.products.map((product) => `
        <div class="product-item">
          <span class="product-emoji" aria-hidden="true">${product.emoji || "📦"}</span>
          <div class="product-info"><strong>${safeText(product.name)}</strong><small class="${product.stock <= 3 ? "stock-warning" : ""}">Còn ${product.stock} sản phẩm</small></div>
          <span class="product-price">${money(product.price)}</span>
          <button class="product-delete" type="button" data-delete-product="${safeText(product.id)}" aria-label="Xóa ${safeText(product.name)}" title="Xóa sản phẩm">×</button>
        </div>`).join("");
    }

    const select = $("#order-product");
    const current = select.value;
    select.innerHTML = state.products.length
      ? state.products.map((product) => `<option value="${safeText(product.id)}" ${product.stock < 1 ? "disabled" : ""}>${safeText(product.name)} — ${money(product.price)} (còn ${product.stock})</option>`).join("")
      : '<option value="">Hãy thêm sản phẩm trước</option>';
    if (state.products.some((product) => product.id === current && product.stock > 0)) select.value = current;
    updateOrderPreview();
  }

  function renderOrders() {
    const search = $("#order-search").value.trim().toLocaleLowerCase("vi");
    const filter = $("#order-filter").value;
    const orders = state.orders.filter((order) => {
      const matchesSearch = (order.id + " " + order.customer + " " + order.productName).toLocaleLowerCase("vi").includes(search);
      return matchesSearch && (filter === "all" || order.status === filter);
    });
    $("#orders-body").innerHTML = orders.map((order) => {
      const nextStatus = { "Mới": "Đang giao", "Đang giao": "Đã giao", "Đã giao": "Đã giao", "Đã hủy": "Đã hủy" }[order.status];
      const canAdvance = order.status === "Mới" || order.status === "Đang giao";
      return `<tr>
        <td><div class="order-id">#${safeText(order.id)}</div><div class="customer-name">${safeText(order.customer)}</div></td>
        <td class="product-cell">${safeText(order.productName)} × ${order.quantity}</td>
        <td class="money">${money(order.unitPrice * order.quantity)}</td>
        <td><span class="status-pill status-${safeText(order.status).replaceAll(" ", "-")}">${safeText(order.status)}</span></td>
        <td><div class="row-actions">${canAdvance ? `<button class="mini-button" type="button" data-advance-order="${safeText(order.id)}" title="Chuyển sang trạng thái tiếp theo">Cập nhật</button>` : ""}${order.status !== "Đã giao" && order.status !== "Đã hủy" ? `<button class="mini-button danger" type="button" data-cancel-order="${safeText(order.id)}" title="Hủy đơn">Hủy</button>` : ""}</div></td>
      </tr>`;
    }).join("");
    $("#orders-empty").hidden = orders.length > 0;
  }

  function render() {
    renderStats();
    renderProducts();
    renderOrders();
  }

  function updateOrderPreview() {
    const product = getProduct($("#order-product").value);
    const quantity = Math.max(1, Number($("#order-quantity").value) || 1);
    $("#order-total-preview").textContent = money(product ? product.price * quantity : 0);
  }

  function resetDemo() {
    state = JSON.parse(JSON.stringify(starterData));
    persist();
    render();
    notify("Đã khôi phục dữ liệu demo ban đầu.");
  }

  $("#product-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#product-name").value.trim();
    const price = Number($("#product-price").value);
    const stock = Number($("#product-stock").value);
    if (!name || !Number.isFinite(price) || price < 1000 || !Number.isInteger(stock) || stock < 0) {
      notify("Vui lòng kiểm tra tên, giá và số lượng sản phẩm.");
      return;
    }
    state.products.unshift({
      id: "SP" + Date.now().toString().slice(-7),
      name, price, stock, emoji: ["📦", "🎁", "🛍️", "✨"][state.products.length % 4]
    });
    persist();
    render();
    event.target.reset();
    $("#product-stock").value = "10";
    notify("Đã thêm sản phẩm.");
  });

  $("#product-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-product]");
    if (!button) return;
    const product = getProduct(button.dataset.deleteProduct);
    if (!product) return;
    if (state.orders.some((order) => order.productId === product.id && order.status !== "Đã hủy")) {
      notify("Không thể xóa sản phẩm đã có trong đơn hàng chưa hủy.");
      return;
    }
    state.products = state.products.filter((item) => item.id !== product.id);
    persist();
    render();
    notify("Đã xóa sản phẩm.");
  });

  $("#orders-body").addEventListener("click", (event) => {
    const advance = event.target.closest("[data-advance-order]");
    const cancel = event.target.closest("[data-cancel-order]");
    if (advance) {
      const order = state.orders.find((item) => item.id === advance.dataset.advanceOrder);
      if (!order) return;
      if (order.status === "Mới") order.status = "Đang giao";
      else if (order.status === "Đang giao") order.status = "Đã giao";
      persist();
      render();
      notify("Đã cập nhật trạng thái đơn hàng.");
    }
    if (cancel) {
      const order = state.orders.find((item) => item.id === cancel.dataset.cancelOrder);
      if (!order) return;
      if (!confirm("Bạn có chắc muốn hủy đơn " + order.id + "?")) return;
      order.status = "Đã hủy";
      const product = getProduct(order.productId);
      if (product) product.stock += order.quantity;
      persist();
      render();
      notify("Đã hủy đơn hàng và hoàn lại số lượng demo.");
    }
  });

  $("#order-search").addEventListener("input", renderOrders);
  $("#order-filter").addEventListener("change", renderOrders);
  $("#order-product").addEventListener("change", updateOrderPreview);
  $("#order-quantity").addEventListener("input", updateOrderPreview);

  const dialog = $("#order-dialog");
  $("#open-order-form").addEventListener("click", () => {
    if (!state.products.some((product) => product.stock > 0)) {
      notify("Hãy thêm sản phẩm còn hàng trước khi tạo đơn.");
      return;
    }
    renderProducts();
    dialog.showModal();
    $("#customer-name").focus();
  });
  function closeDialog() {
    dialog.close();
    $("#order-form").reset();
    $("#order-quantity").value = "1";
    updateOrderPreview();
  }
  $("#close-order-form").addEventListener("click", closeDialog);
  $("#cancel-order-form").addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });

  $("#order-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const customer = $("#customer-name").value.trim();
    const product = getProduct($("#order-product").value);
    const quantity = Number($("#order-quantity").value);
    if (!customer || !product || !Number.isInteger(quantity) || quantity < 1) {
      notify("Vui lòng điền đầy đủ thông tin đơn hàng.");
      return;
    }
    if (quantity > product.stock) {
      notify("Số lượng đặt vượt quá số lượng tồn kho.");
      return;
    }
    product.stock -= quantity;
    state.orders.unshift({
      id: makeId(), customer, productId: product.id, productName: product.name,
      quantity, unitPrice: product.price, status: "Mới", createdAt: new Date().toLocaleDateString("vi-VN")
    });
    persist();
    render();
    closeDialog();
    notify("Tạo đơn hàng thành công.");
  });

  // Chạy nhanh khi demo: khôi phục dữ liệu mẫu bằng ShopMini.resetDemo() trong console.
  window.ShopMini = { resetDemo };
  render();
})();