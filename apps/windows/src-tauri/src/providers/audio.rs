pub trait AudioHandle: Send + Sync {
    fn play(&self) -> crate::error::Result<()>;
    fn stop(&self) -> crate::error::Result<()>;
}

pub trait AudioProvider: Send + Sync {
    fn build_input_stream(
        &self,
        callback: Box<dyn FnMut(&[f32]) + Send + 'static>,
    ) -> crate::error::Result<Box<dyn AudioHandle>>;
}

pub struct RealAudioProvider;

enum AudioCommand {
    Play,
    Terminate,
}

struct RealAudioHandle {
    tx: std::sync::mpsc::Sender<AudioCommand>,
}

impl AudioHandle for RealAudioHandle {
    fn play(&self) -> crate::error::Result<()> {
        self.tx
            .send(AudioCommand::Play)
            .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))
    }

    fn stop(&self) -> crate::error::Result<()> {
        // Terminate the audio thread and release the microphone handle.
        let _ = self.tx.send(AudioCommand::Terminate);
        Ok(())
    }
}

impl Drop for RealAudioHandle {
    fn drop(&mut self) {
        // Ensure the audio thread is terminated when the handle is dropped,
        // so the microphone is released even if stop() was never called.
        let _ = self.tx.send(AudioCommand::Terminate);
    }
}

impl AudioProvider for RealAudioProvider {
    fn build_input_stream(
        &self,
        mut callback: Box<dyn FnMut(&[f32]) + Send + 'static>,
    ) -> crate::error::Result<Box<dyn AudioHandle>> {
        let (tx, rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

            let host = cpal::default_host();
            let device = match host.default_input_device() {
                Some(d) => d,
                None => return,
            };

            let config: cpal::StreamConfig = match device.default_input_config() {
                Ok(c) => c.into(),
                Err(_) => return,
            };

            let stream = device
                .build_input_stream(
                    &config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        callback(data);
                    },
                    |err| tracing::error!("Audio stream error: {}", err),
                    None,
                )
                .ok();

            if let Some(s) = stream {
                loop {
                    match rx.recv() {
                        Ok(AudioCommand::Play) => {
                            let _ = s.play();
                        }
                        // Terminate or channel closed means stop stream and exit thread.
                        Ok(AudioCommand::Terminate) | Err(_) => {
                            let _ = s.pause();
                            // `s` drops here, releasing the mic OS handle.
                            break;
                        }
                    }
                }
            }
            tracing::debug!("Audio thread exited, microphone released.");
        });

        Ok(Box::new(RealAudioHandle { tx }))
    }
}
