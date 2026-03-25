using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Camera;
using WinRT;

namespace OpenClawWindows.Infrastructure.Camera;

internal sealed class WinRTScreenCaptureAdapter : IScreenCapture
{
    private readonly IVideoMuxer _muxer;
    private readonly ILogger<WinRTScreenCaptureAdapter> _logger;

    // Tunables
    private const int MaxFps = 60;   // hard cap
    private const int MinFps = 1;
    private const int DefaultFps = 10;
    private const int MinDurationMs = 250;
    private const int MaxDurationMs = 60_000;

    public WinRTScreenCaptureAdapter(IVideoMuxer muxer, ILogger<WinRTScreenCaptureAdapter> logger)
    {
        _muxer = muxer;
        _logger = logger;
    }

    public async Task<ErrorOr<ScreenRecordingResult>> RecordAsync(
        ScreenRecordingParams p, CancellationToken ct)
    {
        if (p.Format != "mp4")
            return Error.Failure("INVALID_REQUEST: screen format must be mp4");

        if (p.DurationMs is < MinDurationMs or > MaxDurationMs)
            return Error.Failure($"Invalid duration {p.DurationMs}ms (range 250..60000)");

        var fps = Math.Clamp(p.Fps, MinFps, MaxFps);

        var monitors = GetMonitorList();
        if (monitors.Count == 0)
            return Error.Failure("No displays available for screen recording");

        var screenIndex = p.ScreenIndex ?? 0;
        if (screenIndex >= monitors.Count)
            return Error.Failure($"Invalid screen index {screenIndex}");

        var target = monitors[screenIndex];

        // D3D11 device is owned by this capture session; dispose after recording ends.
        var hr = NativeMethods.D3D11CreateDevice(
            IntPtr.Zero,
            NativeMethods.D3D_DRIVER_TYPE_HARDWARE,
            IntPtr.Zero,
            0,
            null, 0,
            NativeMethods.D3D11_SDK_VERSION,
            out var d3dDevice,
            out _,
            out var d3dContext);

        if (hr < 0)
        {
            _logger.LogError("D3D11CreateDevice failed HRESULT=0x{Hr:X}", hr);
            return Error.Failure("SCREEN_D3D_INIT_FAILED");
        }

        // Wrap the DXGI device in a WinRT IDirect3DDevice for Windows.Graphics.Capture.
        var dxgiDevice = NativeMethods.GetDxgiDevice(d3dDevice);
        var winrtDevice = NativeMethods.CreateDirect3DDeviceFromDXGIDevice(dxgiDevice);

        var frames = new List<byte[]>();
        var frameIntervalMs = 1000 / fps;
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        long lastFrameMs = -frameIntervalMs;

        GraphicsCaptureItem item;
        try
        {
            item = target.CreateCaptureItem();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CreateCaptureItem failed for monitor {Idx}", p.ScreenIndex);
            Marshal.Release(d3dDevice);
            Marshal.Release(d3dContext);
            return Error.Failure("SCREEN_CAPTURE_INIT_FAILED");
        }

        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            winrtDevice,
            DirectXPixelFormat.B8G8R8A8UIntNormalized,
            2,
            item.Size);

        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;

        pool.FrameArrived += (_, _) =>
        {
            if (stopwatch.ElapsedMilliseconds - lastFrameMs < frameIntervalMs)
            {
                using var _ = pool.TryGetNextFrame();
                return;
            }

            lastFrameMs = stopwatch.ElapsedMilliseconds;

            using var frame = pool.TryGetNextFrame();
            if (frame is null) return;

            try
            {
                var pixels = ExtractPixelBytes(frame, d3dDevice, d3dContext, item.Size);
                if (pixels.Length > 0)
                    frames.Add(pixels);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Frame extraction failed — skipping frame");
            }
        };

        session.StartCapture();
        await Task.Delay(p.DurationMs, ct);
        session.Dispose();

        Marshal.Release(d3dDevice);
        Marshal.Release(d3dContext);

        if (frames.Count == 0)
            return Error.Failure("No frames captured");

        var rawFrames = CombineFrames(frames);
        var muxResult = await _muxer.MuxAsync(
            rawFrames, audioData: null,
            width: item.Size.Width, height: item.Size.Height,
            p.DurationMs, fps, ct);
        if (muxResult.IsError)
            return muxResult.Errors;

        var base64 = Convert.ToBase64String(muxResult.Value);
        return ScreenRecordingResult.Create(
            base64, p.DurationMs, (float)fps, screenIndex, hasAudio: false);
    }

    private static IReadOnlyList<MonitorInfo> GetMonitorList()
    {
        var monitors = new List<MonitorInfo>();
        NativeMethods.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
            (IntPtr hMonitor, IntPtr hdc, ref NativeRect lprcClip, IntPtr dwData) =>
            {
                monitors.Add(new MonitorInfo(hMonitor));
                return true;
            }, IntPtr.Zero);
        return monitors;
    }

    // Copy the captured texture to a CPU-readable staging texture and read back BGRA pixels.
    // Uses ID3D11DeviceContext::CopyResource + Map/Unmap — the only supported readback path.
    private static byte[] ExtractPixelBytes(
        Direct3D11CaptureFrame frame,
        IntPtr d3dDevice,
        IntPtr d3dContext,
        SizeInt32 size)
    {
        // Obtain the underlying ID3D11Texture2D from the WinRT surface.
        var surface = frame.Surface;
        var dxgiSurface = surface.As<NativeMethods.IDXGISurface>();

        var stagingDesc = new NativeMethods.D3D11_TEXTURE2D_DESC
        {
            Width = (uint)size.Width,
            Height = (uint)size.Height,
            MipLevels = 1,
            ArraySize = 1,
            Format = NativeMethods.DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc = new NativeMethods.DXGI_SAMPLE_DESC { Count = 1, Quality = 0 },
            Usage = NativeMethods.D3D11_USAGE_STAGING,
            BindFlags = 0,
            CPUAccessFlags = NativeMethods.D3D11_CPU_ACCESS_READ,
            MiscFlags = 0,
        };

        var d3dDeviceObj = (NativeMethods.ID3D11Device)Marshal.GetObjectForIUnknown(d3dDevice);
        d3dDeviceObj.CreateTexture2D(ref stagingDesc, IntPtr.Zero, out var stagingTexture);

        // QI for the source texture from the DXGI surface.
        var srcTexture = (NativeMethods.ID3D11Texture2D)Marshal.GetObjectForIUnknown(
            Marshal.GetIUnknownForObject(dxgiSurface));

        var d3dCtxObj = (NativeMethods.ID3D11DeviceContext)Marshal.GetObjectForIUnknown(d3dContext);
        d3dCtxObj.CopyResource(stagingTexture, srcTexture);

        d3dCtxObj.Map(stagingTexture, 0, NativeMethods.D3D11_MAP_READ, 0,
            out var mappedResource);

        var stride = mappedResource.RowPitch;
        var byteWidth = (int)size.Width * 4; // BGRA = 4 bytes/pixel
        var pixels = new byte[(int)size.Height * byteWidth];

        for (var row = 0; row < size.Height; row++)
        {
            var src = mappedResource.pData + row * (int)stride;
            Marshal.Copy(src, pixels, row * byteWidth, byteWidth);
        }

        d3dCtxObj.Unmap(stagingTexture, 0);
        Marshal.ReleaseComObject(stagingTexture);

        return pixels;
    }

    private static byte[] CombineFrames(IReadOnlyList<byte[]> frames)
    {
        var total = frames.Sum(f => f.Length);
        var result = new byte[total];
        var offset = 0;
        foreach (var frame in frames)
        {
            Buffer.BlockCopy(frame, 0, result, offset, frame.Length);
            offset += frame.Length;
        }
        return result;
    }

    private static class NativeMethods
    {
        internal const int D3D_DRIVER_TYPE_HARDWARE = 1;
        internal const int D3D11_SDK_VERSION = 7;
        internal const int DXGI_FORMAT_B8G8R8A8_UNORM = 87;
        internal const int D3D11_USAGE_STAGING = 3;
        internal const int D3D11_CPU_ACCESS_READ = 0x20000;
        internal const int D3D11_MAP_READ = 1;

        [DllImport("d3d11.dll")]
        internal static extern int D3D11CreateDevice(
            IntPtr pAdapter, int DriverType, IntPtr Software, int Flags,
            int[]? pFeatureLevels, int FeatureLevels, int SDKVersion,
            out IntPtr ppDevice, out int pFeatureLevel, out IntPtr ppImmediateContext);

        // Returns the IDXGIDevice interface from an ID3D11Device pointer.
        internal static IntPtr GetDxgiDevice(IntPtr d3dDevice)
        {
            var d3d = (ID3D11Device)Marshal.GetObjectForIUnknown(d3dDevice);
            d3d.GetDXGIDevice(out var dxgi);
            return Marshal.GetIUnknownForObject(dxgi);
        }

        // WinRT factory function in d3d11.dll that bridges DXGI ↔ Windows.Graphics.DirectX.
        [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice",
            PreserveSig = false)]
        [return: MarshalAs(UnmanagedType.IInspectable)]
        internal static extern IDirect3DDevice CreateDirect3DDeviceFromDXGIDevice(
            IntPtr dxgiDevice);

        internal delegate bool MonitorEnumDelegate(
            IntPtr hMonitor, IntPtr hdcMonitor, ref NativeRect lprcMonitor, IntPtr dwData);

        [DllImport("user32.dll")]
        internal static extern bool EnumDisplayMonitors(
            IntPtr hdc, IntPtr lprcClip, MonitorEnumDelegate lpfnEnum, IntPtr dwData);

        [StructLayout(LayoutKind.Sequential)]
        internal struct D3D11_TEXTURE2D_DESC
        {
            public uint Width, Height, MipLevels, ArraySize, Format;
            public DXGI_SAMPLE_DESC SampleDesc;
            public int Usage, BindFlags, CPUAccessFlags, MiscFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct DXGI_SAMPLE_DESC { public uint Count, Quality; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct D3D11_MAPPED_SUBRESOURCE
        {
            public IntPtr pData;
            public uint RowPitch, DepthPitch;
        }

        [ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface ID3D11Device
        {
            void CreateBuffer();
            void CreateTexture1D();
            int CreateTexture2D(
                ref D3D11_TEXTURE2D_DESC pDesc,
                IntPtr pInitialData,
                [MarshalAs(UnmanagedType.Interface)] out ID3D11Texture2D ppTexture2D);
            // Remaining vtable slots — must exist for correct vtable offset.
            void CreateTexture3D();
            void CreateShaderResourceView();
            void CreateUnorderedAccessView();
            void CreateRenderTargetView();
            void CreateDepthStencilView();
            void CreateInputLayout();
            void CreateVertexShader();
            void CreateGeometryShader();
            void CreateGeometryShaderWithStreamOutput();
            void CreatePixelShader();
            void CreateHullShader();
            void CreateDomainShader();
            void CreateComputeShader();
            void CreateClassLinkage();
            void CreateBlendState();
            void CreateDepthStencilState();
            void CreateRasterizerState();
            void CreateSamplerState();
            void CreateQuery();
            void CreatePredicate();
            void CreateCounter();
            void CreateDeferredContext();
            void OpenSharedResource();
            void CheckFormatSupport();
            void CheckMultisampleQualityLevels();
            void CheckCounterInfo();
            void CheckCounter();
            void CheckFeatureSupport();
            void GetPrivateData();
            void SetPrivateData();
            void SetPrivateDataInterface();
            void GetFeatureLevel();
            void GetCreationFlags();
            void GetDeviceRemovedReason();
            void GetImmediateContext();
            void SetExceptionMode();
            void GetExceptionMode();
            void GetDXGIDevice(
                [MarshalAs(UnmanagedType.Interface)] out IDXGIDevice ppDXGIDevice);
        }

        [ComImport, Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface ID3D11DeviceContext
        {
            // Vtable stubs through slot 46 (CopyResource is slot 47 in ID3D11DeviceContext).
            void VSSetConstantBuffers();
            void PSSetShaderResources();
            void PSSetShader();
            void PSSetSamplers();
            void VSSetShader();
            void DrawIndexed();
            void Draw();
            int Map(
                [MarshalAs(UnmanagedType.Interface)] object pResource,
                uint Subresource,
                int MapType,
                uint MapFlags,
                out D3D11_MAPPED_SUBRESOURCE pMappedResource);
            void Unmap(
                [MarshalAs(UnmanagedType.Interface)] object pResource,
                uint Subresource);
            void PSSetConstantBuffers();
            void IASetInputLayout();
            void IASetVertexBuffers();
            void IASetIndexBuffer();
            void DrawIndexedInstanced();
            void DrawInstanced();
            void GSSetConstantBuffers();
            void GSSetShader();
            void IASetPrimitiveTopology();
            void VSSetShaderResources();
            void VSSetSamplers();
            void Begin();
            void End();
            void GetData();
            void SetPredication();
            void GSSetShaderResources();
            void GSSetSamplers();
            void OMSetRenderTargets();
            void OMSetRenderTargetsAndUnorderedAccessViews();
            void OMSetBlendState();
            void OMSetDepthStencilState();
            void SOSetTargets();
            void DrawAuto();
            void DrawIndexedInstancedIndirect();
            void DrawInstancedIndirect();
            void Dispatch();
            void DispatchIndirect();
            void RSSetState();
            void RSSetViewports();
            void RSSetScissorRects();
            void CopySubresourceRegion();
            void CopyResource(
                [MarshalAs(UnmanagedType.Interface)] object pDstResource,
                [MarshalAs(UnmanagedType.Interface)] object pSrcResource);
            void UpdateSubresource();
            void CopyStructureCount();
            void ClearRenderTargetView();
            void ClearUnorderedAccessViewUint();
            void ClearUnorderedAccessViewFloat();
            void ClearDepthStencilView();
            void GenerateMips();
            void SetResourceMinLOD();
            void GetResourceMinLOD();
            void ResolveSubresource();
            void ExecuteCommandList();
            void HSSetShaderResources();
            void HSSetShader();
            void HSSetSamplers();
            void HSSetConstantBuffers();
            void DSSetShaderResources();
            void DSSetShader();
            void DSSetSamplers();
            void DSSetConstantBuffers();
            void CSSetShaderResources();
            void CSSetUnorderedAccessViews();
            void CSSetShader();
            void CSSetSamplers();
            void CSSetConstantBuffers();
            void VSGetConstantBuffers();
            void PSGetShaderResources();
            void PSGetShader();
            void PSGetSamplers();
            void VSGetShader();
            void PSGetConstantBuffers();
            void IAGetInputLayout();
            void IAGetVertexBuffers();
            void IAGetIndexBuffer();
            void GSGetConstantBuffers();
            void GSGetShader();
            void IAGetPrimitiveTopology();
            void VSGetShaderResources();
            void VSGetSamplers();
            void GetPredication();
            void GSGetShaderResources();
            void GSGetSamplers();
            void OMGetRenderTargets();
            void OMGetRenderTargetsAndUnorderedAccessViews();
            void OMGetBlendState();
            void OMGetDepthStencilState();
            void SOGetTargets();
            void RSGetState();
            void RSGetViewports();
            void RSGetScissorRects();
            void HSGetShaderResources();
            void HSGetShader();
            void HSGetSamplers();
            void HSGetConstantBuffers();
            void DSGetShaderResources();
            void DSGetShader();
            void DSGetSamplers();
            void DSGetConstantBuffers();
            void CSGetShaderResources();
            void CSGetUnorderedAccessViews();
            void CSGetShader();
            void CSGetSamplers();
            void CSGetConstantBuffers();
            void ClearState();
            void Flush();
            void GetType();
            void GetContextFlags();
            void FinishCommandList();
        }

        [ComImport, Guid("cafcb56c-6ac3-4889-bf47-9e23bbd260ec"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface ID3D11Texture2D
        {
            // ID3D11DeviceChild + ID3D11Resource methods (slots 3-10)
            void GetDevice();
            void GetPrivateData();
            void SetPrivateData();
            void SetPrivateDataInterface();
            void GetType();
            void SetEvictionPriority();
            void GetEvictionPriority();
            void GetDesc();
        }

        [ComImport, Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IDXGIDevice { }

        [ComImport, Guid("cafcb56c-6ac3-4889-bf47-9e23bbd260ec"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IDXGISurface { }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { public int Left, Top, Right, Bottom; }

    private sealed class MonitorInfo
    {
        private readonly IntPtr _handle;
        public MonitorInfo(IntPtr handle) => _handle = handle;

        // Uses IGraphicsCaptureItemInterop::CreateForMonitor to wrap a Win32 HMONITOR
        // as a WinRT GraphicsCaptureItem — the only supported path for non-UWP apps.
        public GraphicsCaptureItem CreateCaptureItem()
        {
            var interop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
            var itemGuid = typeof(GraphicsCaptureItem).GUID;
            interop.CreateForMonitor(_handle, ref itemGuid, out var item);
            return item;
        }
    }

    // IGraphicsCaptureItemInterop — factory for creating capture items from Win32 handles.
    [ComImport,
     Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        void CreateForWindow(IntPtr hwnd, ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out GraphicsCaptureItem item);

        void CreateForMonitor(IntPtr hmon, ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out GraphicsCaptureItem item);
    }
}
