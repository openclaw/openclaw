function attachIMessageMonitorAbortHandler(params) {
  const abort = params.abortSignal;
  if (!abort) {
    return () => {
    };
  }
  const onAbort = () => {
    const subscriptionId = params.getSubscriptionId();
    if (subscriptionId) {
      void params.client.request("watch.unsubscribe", {
        subscription: subscriptionId
      }).catch(() => {
      });
    }
    void params.client.stop().catch(() => {
    });
  };
  abort.addEventListener("abort", onAbort, { once: true });
  return () => abort.removeEventListener("abort", onAbort);
}
export {
  attachIMessageMonitorAbortHandler
};
