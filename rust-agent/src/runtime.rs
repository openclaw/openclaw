use std::sync::Arc;

use anyhow::Result;
use tokio::signal;
use tracing::info;

use crate::bridge::GatewayBridge;
use crate::config::Config;
use crate::memory;
use crate::security::{ActionEvaluator, DefenderEngine};

pub struct AgentRuntime {
    config: Config,
    evaluator: Arc<dyn ActionEvaluator>,
}

impl AgentRuntime {
    pub async fn new(config: Config) -> Result<Self> {
        let evaluator: Arc<dyn ActionEvaluator> = DefenderEngine::new(config.clone()).await?;
        Ok(Self { config, evaluator })
    }

    pub async fn run(self) -> Result<()> {
        tokio::spawn(memory::run_sampler(self.config.runtime.memory_sample_secs));

        let bridge = GatewayBridge::new(
            self.config.gateway.clone(),
            self.config.runtime.decision_event.clone(),
            self.config.runtime.max_queue,
            self.config.runtime.session_queue_mode,
            self.config.runtime.group_activation_mode,
        );

        info!(
            "starting runtime (audit_only={}, workers={}, max_queue={}, queue_mode={:?}, group_activation={:?}, idem_ttl_s={}, idem_max={})",
            self.config.runtime.audit_only,
            self.config.runtime.worker_concurrency,
            self.config.runtime.max_queue,
            self.config.runtime.session_queue_mode,
            self.config.runtime.group_activation_mode,
            self.config.runtime.idempotency_ttl_secs,
            self.config.runtime.idempotency_max_entries
        );

        tokio::select! {
            res = bridge.run_forever(self.evaluator.clone()) => res,
            _ = signal::ctrl_c() => {
                info!("received ctrl-c, shutting down");
                Ok(())
            }
        }
    }
}
