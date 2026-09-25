#ifndef OPENCLAW_AUDIO_AEC_H
#define OPENCLAW_AUDIO_AEC_H
#ifdef __cplusplus
extern "C" {
#endif
// One serialized owner per instance. Frames are mono Float32, 480 samples at48kHz.
void *oc_audio_aec_create(void);
int oc_audio_aec_process(void *state, const float *render, const float *capture, float *output);
void oc_audio_aec_destroy(void *state);
#ifdef __cplusplus
}
#endif
#endif
