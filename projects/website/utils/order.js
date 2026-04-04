export function parseOrderIdString(order) {
  return order ? String(order.order_id) : '--';
}

export function parseOrderStateName(order) {
  return {
    created: '待繳費',
    payed: '待驗證',
    messaged: '審核中',
    confirmed: '報名完成',
  }[order.state] ?? '--';
}
