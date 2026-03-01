use async_trait::async_trait;
use std::sync::Mutex;
use windows::{
    core::Interface,
    Foundation::{TimeSpan, TypedEventHandler},
    Globalization::Language,
    Media::SpeechRecognition::{
        ISpeechRecognitionConstraint, SpeechContinuousRecognitionCompletedEventArgs,
        SpeechContinuousRecognitionMode, SpeechContinuousRecognitionResultGeneratedEventArgs,
        SpeechContinuousRecognitionSession, SpeechRecognitionAudioProblem,
        SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionQualityDegradingEventArgs,
        SpeechRecognitionResultStatus, SpeechRecognitionScenario, SpeechRecognitionTopicConstraint,
        SpeechRecognizer,
    },
};

#[async_trait]
pub trait SpeechProvider: Send + Sync {
    async fn start_recognition(
        &self,
        options: RecognitionOptions,
        on_result: Box<dyn FnMut(RecognitionEvent) + Send + 'static>,
    ) -> crate::error::Result<()>;
    async fn stop_recognition(&self) -> crate::error::Result<()>;
    async fn list_microphones(&self) -> crate::error::Result<Vec<AudioDevice>>;
    async fn list_locales(&self) -> crate::error::Result<Vec<String>>;
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct RecognitionOptions {
    pub mic_id: Option<String>,
    pub locale: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RecognitionEvent {
    pub transcript: String,
    pub is_final: bool,
    pub session_completed: bool,
    pub status: Option<i32>,
}

pub struct WindowsSpeechProvider {
    recognizer: Mutex<Option<SpeechRecognizer>>,
}

impl WindowsSpeechProvider {
    pub fn new() -> Self {
        Self {
            recognizer: Mutex::new(None),
        }
    }

    fn map_speech_start_error(err_text: &str) -> String {
        let lower = err_text.to_ascii_lowercase();
        if lower.contains("0x80045509")
            || (lower.contains("speech privacy policy") && lower.contains("not accepted"))
        {
            return "Windows speech policy is not enabled (0x80045509). Open Settings > Privacy & security > Speech, turn on Online speech recognition, then restart OpenClaw.".to_string();
        }

        if lower.contains("0x800455bc") || lower.contains("privacy settings") {
            return "Speech recognition is blocked by Windows privacy settings. Open Settings > Privacy & security > Speech and enable Online speech recognition.".to_string();
        }

        format!(
            "Failed to start speech session. Ensure your microphone is connected and not in use by another exclusive app. Error: {}",
            err_text
        )
    }
}

#[async_trait]
impl SpeechProvider for WindowsSpeechProvider {
    async fn start_recognition(
        &self,
        options: RecognitionOptions,
        on_result: Box<dyn FnMut(RecognitionEvent) + Send + 'static>,
    ) -> crate::error::Result<()> {
        // Stop any existing session first to ensure clean state
        self.stop_recognition().await?;
        tracing::info!(
            "Starting Windows speech recognition (locale='{}').",
            options.locale.as_deref().unwrap_or("system-default")
        );

        if options
            .mic_id
            .as_ref()
            .is_some_and(|v| !v.trim().is_empty())
        {
            tracing::info!(
                "Windows Speech API uses the system default microphone; selected mic id is advisory only."
            );
        }

        let recognizer = if let Some(locale_id) = &options.locale {
            let trimmed = locale_id.trim();
            if trimmed.is_empty() {
                SpeechRecognizer::new().map_err(|e| {
                    crate::error::OpenClawError::Internal(format!(
                        "Failed to create SpeechRecognizer. Please ensure Microphone permissions are granted in Windows Settings. Error: {}",
                        e
                    ))
                })?
            } else {
                let locale_hs = windows::core::HSTRING::from(trimmed);
                let lang = Language::CreateLanguage(&locale_hs).map_err(|e| {
                    crate::error::OpenClawError::Internal(format!(
                        "Unsupported language {}: {}",
                        trimmed, e
                    ))
                })?;
                match SpeechRecognizer::Create(&lang) {
                    Ok(recognizer) => recognizer,
                    Err(err) => {
                        tracing::warn!(
                            "Failed to create locale-specific recognizer for '{}': {}. Falling back to system language.",
                            trimmed,
                            err
                        );
                        SpeechRecognizer::new().map_err(|e| {
                            crate::error::OpenClawError::Internal(format!(
                                "Failed to create SpeechRecognizer fallback. Error: {}",
                                e
                            ))
                        })?
                    }
                }
            }
        } else {
            SpeechRecognizer::new().map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to create SpeechRecognizer. Please ensure Microphone permissions are granted in Windows Settings. Error: {}",
                    e
                ))
            })?
        };

        // Force dictation constraints for free-form phrases (wake/PTT commands).
        {
            let constraints = recognizer.Constraints().map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to access speech constraints: {}",
                    e
                ))
            })?;
            let _ = constraints.Clear();
            let topic = SpeechRecognitionTopicConstraint::Create(
                SpeechRecognitionScenario::Dictation,
                &windows::core::HSTRING::from("OpenClaw voice command"),
            )
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to create dictation speech constraint: {}",
                    e
                ))
            })?;
            let topic_constraint: ISpeechRecognitionConstraint = topic.cast().map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to cast dictation constraint: {}",
                    e
                ))
            })?;
            constraints.Append(&topic_constraint).map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to append dictation constraint: {}",
                    e
                ))
            })?;
        }

        let compilation_op = recognizer.CompileConstraintsAsync().map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to compile speech constraints: {}",
                e
            ))
        })?;

        let compilation_result = compilation_op.await.map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Speech compilation failed. This may happen if 'Online Speech Recognition' is disabled in Windows Privacy settings. Error: {}", e))
        })?;
        let compilation_status = compilation_result.Status().map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to read speech compilation status: {}",
                e
            ))
        })?;
        tracing::info!(
            "Speech constraints compiled with status={}",
            compilation_status.0
        );
        if compilation_status != SpeechRecognitionResultStatus::Success {
            return Err(crate::error::OpenClawError::Internal(format!(
                "Speech recognition constraints failed to compile (status={}).",
                compilation_status.0
            )));
        }

        let session = recognizer.ContinuousRecognitionSession().map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to get speech recognition session: {}",
                e
            ))
        })?;

        // Keep session alive for always-on wake listening.
        let _ = session.SetAutoStopSilenceTimeout(TimeSpan {
            Duration: 30_i64 * 60 * 10_000_000, // 30 minutes (100ns ticks)
        });
        if let Ok(timeouts) = recognizer.Timeouts() {
            let _ = timeouts.SetInitialSilenceTimeout(TimeSpan {
                Duration: 10_i64 * 10_000_000, // 10s
            });
            let _ = timeouts.SetEndSilenceTimeout(TimeSpan {
                Duration: 1_i64 * 10_000_000, // 1s
            });
            let _ = timeouts.SetBabbleTimeout(TimeSpan {
                Duration: 30_i64 * 10_000_000, // 30s
            });
        }

        let on_result_mutex = std::sync::Arc::new(Mutex::new(on_result));

        // Handle results inside a block so the handler isn't held across the await
        {
            let on_result_mutex = on_result_mutex.clone();
            let handler = TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionResultGeneratedEventArgs,
            >::new(move |_sender, args| {
                if let Some(args) = &*args {
                    if let Ok(result) = args.Result() {
                        if let Ok(text) = result.Text() {
                            let text_string = text.to_string();
                            if !text_string.is_empty() {
                                tracing::info!(
                                    "Speech final result received (len={})",
                                    text_string.len()
                                );
                                if let Ok(mut lock) = on_result_mutex.lock() {
                                    lock(RecognitionEvent {
                                        transcript: text_string,
                                        is_final: true,
                                        session_completed: false,
                                        status: None,
                                    });
                                }
                            }
                        }
                    }
                }
                Ok(())
            });

            session.ResultGenerated(&handler).map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to register speech result handler: {}",
                    e
                ))
            })?;
        }

        {
            let on_result_mutex = on_result_mutex.clone();
            let handler = TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionCompletedEventArgs,
            >::new(move |_sender, args| {
                let mut status_code: Option<i32> = None;
                if let Some(args) = &*args {
                    if let Ok(status) = args.Status() {
                        status_code = Some(status.0);
                        if status == SpeechRecognitionResultStatus::Success {
                            tracing::info!(
                                "Speech continuous session completed with status={}",
                                status.0
                            );
                        } else {
                            tracing::warn!(
                                "Speech continuous session completed with non-success status={}",
                                status.0
                            );
                        }
                    }
                }
                if let Ok(mut lock) = on_result_mutex.lock() {
                    lock(RecognitionEvent {
                        transcript: String::new(),
                        is_final: false,
                        session_completed: true,
                        status: status_code,
                    });
                }
                Ok(())
            });
            let _ = session.Completed(&handler);
        }

        {
            let on_result_mutex = on_result_mutex.clone();
            let handler = TypedEventHandler::<
                SpeechRecognizer,
                SpeechRecognitionHypothesisGeneratedEventArgs,
            >::new(move |_sender, args| {
                if let Some(args) = &*args {
                    if let Ok(hypothesis) = args.Hypothesis() {
                        if let Ok(text) = hypothesis.Text() {
                            let text_string = text.to_string();
                            if !text_string.is_empty() {
                                tracing::info!(
                                    "Speech partial hypothesis received (len={})",
                                    text_string.len()
                                );
                                if let Ok(mut lock) = on_result_mutex.lock() {
                                    lock(RecognitionEvent {
                                        transcript: text_string,
                                        is_final: false,
                                        session_completed: false,
                                        status: None,
                                    });
                                }
                            }
                        }
                    }
                }
                Ok(())
            });

            recognizer.HypothesisGenerated(&handler).map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to register speech hypothesis handler: {}",
                    e
                ))
            })?;
        }

        {
            let handler = TypedEventHandler::<
                SpeechRecognizer,
                SpeechRecognitionQualityDegradingEventArgs,
            >::new(move |_sender, args| {
                if let Some(args) = &*args {
                    if let Ok(problem) = args.Problem() {
                        let label = match problem {
                            SpeechRecognitionAudioProblem::TooNoisy => "too_noisy",
                            SpeechRecognitionAudioProblem::NoSignal => "no_signal",
                            SpeechRecognitionAudioProblem::TooLoud => "too_loud",
                            SpeechRecognitionAudioProblem::TooQuiet => "too_quiet",
                            SpeechRecognitionAudioProblem::TooFast => "too_fast",
                            SpeechRecognitionAudioProblem::TooSlow => "too_slow",
                            SpeechRecognitionAudioProblem::None => "none",
                            _ => "unknown",
                        };
                        tracing::warn!("Speech quality degrading: {}", label);
                    }
                }
                Ok(())
            });
            let _ = recognizer.RecognitionQualityDegrading(&handler);
        }

        let start_op = session
            .StartWithModeAsync(SpeechContinuousRecognitionMode::Default)
            .map_err(|e| {
                crate::error::OpenClawError::Internal(Self::map_speech_start_error(&e.to_string()))
            })?;

        start_op.await.map_err(|e| {
            crate::error::OpenClawError::Internal(Self::map_speech_start_error(&e.to_string()))
        })?;
        tracing::info!("Windows speech recognition session started.");

        let mut lock = self.recognizer.lock().unwrap();
        *lock = Some(recognizer);

        Ok(())
    }

    async fn stop_recognition(&self) -> crate::error::Result<()> {
        let recognizer = {
            let mut lock = self.recognizer.lock().unwrap();
            lock.take()
        };

        if let Some(recognizer) = recognizer {
            if let Ok(session) = recognizer.ContinuousRecognitionSession() {
                // Ignore errors on stop, we just want it to end
                if let Ok(op) = session.StopAsync() {
                    let _ = op.await;
                }
            }
        }
        Ok(())
    }

    async fn list_microphones(&self) -> crate::error::Result<Vec<AudioDevice>> {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let devices = host.input_devices().map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to list input devices: {}", e))
        })?;

        let mut result = Vec::new();
        for device in devices {
            if let Ok(name) = device.name() {
                result.push(AudioDevice {
                    id: name.clone(),
                    name,
                });
            }
        }
        Ok(result)
    }

    async fn list_locales(&self) -> crate::error::Result<Vec<String>> {
        let langs = SpeechRecognizer::SupportedGrammarLanguages().map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to list supported languages: {}",
                e
            ))
        })?;

        let mut result = Vec::new();
        for lang in langs {
            if let Ok(tag) = lang.LanguageTag() {
                result.push(tag.to_string());
            }
        }
        Ok(result)
    }
}
