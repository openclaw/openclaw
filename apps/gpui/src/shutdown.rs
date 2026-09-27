use async_channel::Receiver;
use tokio::{
    runtime::Handle,
    signal::unix::{SignalKind, signal},
};

/// Register before opening windows so no tunnel can precede the signal handlers.
pub fn watch_signals(runtime: &Handle) -> std::io::Result<Receiver<()>> {
    let _runtime = runtime.enter();
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut hangup = signal(SignalKind::hangup())?;
    let (notify, receiver) = async_channel::bounded(1);
    runtime.spawn(async move {
        let mut shutting_down = false;
        loop {
            let received = tokio::select! {
                _ = terminate.recv() => SignalKind::terminate(),
                _ = interrupt.recv() => SignalKind::interrupt(),
                _ = hangup.recv() => SignalKind::hangup(),
            };
            // This runs on the runtime, never inside the Unix signal handler.
            // Fence spawns and kill process groups even if the UI thread is busy.
            crate::gateway::remote_tunnel::shutdown_all();
            if shutting_down {
                std::process::exit(128 + received.as_raw_value());
            }
            shutting_down = true;
            let _ = notify.try_send(());
        }
    });
    Ok(receiver)
}

#[cfg(test)]
mod tests;
