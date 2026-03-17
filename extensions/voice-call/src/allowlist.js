function normalizePhoneNumber(input) {
  if (!input) {
    return "";
  }
  return input.replace(/\D/g, "");
}
function isAllowlistedCaller(normalizedFrom, allowFrom) {
  if (!normalizedFrom) {
    return false;
  }
  return (allowFrom ?? []).some((num) => {
    const normalizedAllow = normalizePhoneNumber(num);
    return normalizedAllow !== "" && normalizedAllow === normalizedFrom;
  });
}
export {
  isAllowlistedCaller,
  normalizePhoneNumber
};
