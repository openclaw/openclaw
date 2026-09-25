#include "OpenClawAudioAEC.h"
#if !__has_include("api/audio/audio_processing.h")
#error "Run scripts/build-mac-aec.sh before building the Mac app"
#endif
#include "api/audio/audio_processing.h"
#include <array>
#include <cmath>
#include <new>

namespace {
struct EchoProcessor {
    rtc::scoped_refptr<webrtc::AudioProcessing> apm;
    webrtc::StreamConfig format{48000, 1};
    std::array<float, 480> renderOutput{};
    EchoProcessor() : apm(webrtc::AudioProcessingBuilder().Create()) {
        if (!apm) throw std::bad_alloc();
        webrtc::AudioProcessing::Config config;
        config.echo_canceller.enabled = true;
        // No gain or noise suppression: only remove the rendered speaker echo.
        apm->ApplyConfig(config);
    }
};
}
extern "C" void *oc_audio_aec_create(void) {
    try { return new EchoProcessor; } catch (...) { return nullptr; }
}
extern "C" int oc_audio_aec_process(void *state, const float *render, const float *capture, float *output) {
    if (!state || !render || !capture || !output) return -1;
    for (int i = 0; i < 480; ++i) {
        if (!std::isfinite(render[i]) || !std::isfinite(capture[i])) return -1;
    }
    auto &self = *static_cast<EchoProcessor *>(state);
    const float *reverse[] = {render};
    float *reverseOutput[] = {self.renderOutput.data()};
    int result = self.apm->ProcessReverseStream(reverse, self.format, self.format, reverseOutput);
    if (result != 0) return result;
    // Swift aligns both streams by hardware host time before this call. Queue
    // latency is common to the pair, so their additional relative delay is0.
    result = self.apm->set_stream_delay_ms(0);
    if (result != 0) return result;
    const float *input[] = {capture};
    float *out[] = {output};
    return self.apm->ProcessStream(input, self.format, self.format, out);
}
extern "C" void oc_audio_aec_destroy(void *state) {
    delete static_cast<EchoProcessor *>(state);
}
