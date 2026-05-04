import Testing
@testable import OpenClawKit

struct ElevenLabsTTSValidationTests {
    @Test func validatedOutputFormatAllowsOnlyMp3Presets() {
        #expect(ElevenLabsTTSClient.validatedOutputFormat("mp3_44100_128") == "mp3_44100_128")
        #expect(ElevenLabsTTSClient.validatedOutputFormat("pcm_16000") == "pcm_16000")
    }

    @Test func validatedLanguageAcceptsTwoLetterCodes() {
        #expect(ElevenLabsTTSClient.validatedLanguage("EN") == "en")
        #expect(ElevenLabsTTSClient.validatedLanguage("eng") == nil)
    }

    @Test func validatedNormalizeAcceptsKnownValues() {
        #expect(ElevenLabsTTSClient.validatedNormalize("AUTO") == "auto")
        #expect(ElevenLabsTTSClient.validatedNormalize("maybe") == nil)
    }
}
