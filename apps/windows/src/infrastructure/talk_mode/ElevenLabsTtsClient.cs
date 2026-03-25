using System.Net.Http.Json;
using System.Text.Json;
using NAudio.Wave;

namespace OpenClawWindows.Infrastructure.TalkMode;

// HTTP client for ElevenLabs TTS streaming API + NAudio playback.
internal sealed class ElevenLabsTtsClient
{
    private const string BaseUrl = "https://api.elevenlabs.io/v1";

    private readonly string _apiKey;
    private readonly HttpClient _http;

    internal ElevenLabsTtsClient(string apiKey, HttpClient http)
    {
        _apiKey = apiKey;
        _http = http;
    }

    // Synthesizes text and plays it. Returns true if playback completed, false if interrupted.
    internal async Task<bool> StreamAndPlayAsync(
        string voiceId,
        string text,
        string? modelId,
        string outputFormat,
        CancellationToken ct)
    {
        using var req = new HttpRequestMessage(
            HttpMethod.Post,
            $"{BaseUrl}/text-to-speech/{voiceId}/stream");
        req.Headers.TryAddWithoutValidation("xi-api-key", _apiKey);
        req.Content = JsonContent.Create(new
        {
            text,
            model_id = modelId ?? "eleven_v3",
            output_format = outputFormat,
        });

        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();

        using var stream = await resp.Content.ReadAsStreamAsync(ct);

        int sampleRate = PcmSampleRate(outputFormat);
        if (sampleRate > 0)
            return await PlayPcmAsync(stream, sampleRate, ct);

        return await PlayMp3Async(stream, ct);
    }

    // Returns the ElevenLabs voice list to find a fallback voice ID.
    internal async Task<string?> GetFirstVoiceIdAsync(CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{BaseUrl}/voices");
        req.Headers.TryAddWithoutValidation("xi-api-key", _apiKey);
        using var resp = await _http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();
        using var doc = await JsonDocument.ParseAsync(
            await resp.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
        var voices = doc.RootElement.GetProperty("voices");
        if (voices.GetArrayLength() == 0) return null;
        return voices[0].TryGetProperty("voice_id", out var v) ? v.GetString() : null;
    }

    internal static int PcmSampleRate(string? fmt) => fmt switch
    {
        "pcm_44100" => 44100,
        "pcm_22050" => 22050,
        "pcm_16000" => 16000,
        _ => 0,
    };

    // Streams PCM chunks into a NAudio BufferedWaveProvider and plays via WaveOutEvent.
    private static async Task<bool> PlayPcmAsync(Stream stream, int sampleRate, CancellationToken ct)
    {
        // ElevenLabs PCM: 16-bit signed, mono, at the declared sample rate.
        var format = new WaveFormat(sampleRate, 16, 1);
        var buffer = new BufferedWaveProvider(format) { DiscardOnBufferOverflow = true };
        using var player = new WaveOutEvent();
        player.Init(buffer);
        player.Play();

        var chunk = new byte[4096];
        try
        {
            int read;
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
            {
                buffer.AddSamples(chunk, 0, read);
                // Throttle writes so we don't flood the buffer (2 s of audio = 176 400 bytes at 44100 Hz).
                while (buffer.BufferedBytes > 176_400 && player.PlaybackState == PlaybackState.Playing)
                    await Task.Delay(20, ct);
            }
            // Drain remaining buffered samples.
            while (buffer.BufferedBytes > 0 && player.PlaybackState == PlaybackState.Playing)
                await Task.Delay(20, ct);
            return true;
        }
        catch (OperationCanceledException) { return false; }
        finally { player.Stop(); }
    }

    // Buffers the full MP3 response then plays via NAudio Mp3FileReader.
    private static async Task<bool> PlayMp3Async(Stream stream, CancellationToken ct)
    {
        // Buffer everything first — ElevenLabs MP3 stream is not locally seekable.
        var ms = new MemoryStream();
        try { await stream.CopyToAsync(ms, ct); }
        catch (OperationCanceledException) { return false; }

        ms.Position = 0;
        using var mp3 = new Mp3FileReader(ms);
        using var player = new WaveOutEvent();
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        player.PlaybackStopped += (_, _) => tcs.TrySetResult(true);
        player.Init(mp3);
        player.Play();

        try
        {
            await tcs.Task.WaitAsync(ct);
            return true;
        }
        catch (OperationCanceledException) { player.Stop(); return false; }
    }
}
