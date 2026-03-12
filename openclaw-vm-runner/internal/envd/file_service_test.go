package envd

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

func setupFileTestServer(t *testing.T, root string) (pb.FileServiceClient, func()) {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	srv := grpc.NewServer()
	pb.RegisterFileServiceServer(srv, NewFileServerWithRoot(root))

	go func() { _ = srv.Serve(lis) }()

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)

	client := pb.NewFileServiceClient(conn)
	cleanup := func() {
		conn.Close()
		srv.Stop()
		lis.Close()
	}
	return client, cleanup
}

// --- Stat tests ---

func TestStat_RegularFile(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	require.NoError(t, os.WriteFile(filepath.Join(tmp, "test.txt"), []byte("hello"), 0644))

	resp, err := client.Stat(context.Background(), &pb.StatRequest{Path: "test.txt"})
	require.NoError(t, err)

	assert.Equal(t, "test.txt", resp.GetPath())
	assert.Equal(t, int64(5), resp.GetSize())
	assert.False(t, resp.GetIsDir())
	assert.NotZero(t, resp.GetModTimeUnix())
	assert.NotZero(t, resp.GetMode())
}

func TestStat_Directory(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	require.NoError(t, os.Mkdir(filepath.Join(tmp, "subdir"), 0755))

	resp, err := client.Stat(context.Background(), &pb.StatRequest{Path: "subdir"})
	require.NoError(t, err)

	assert.True(t, resp.GetIsDir())
	assert.Equal(t, "subdir", resp.GetPath())
}

func TestStat_NotFound(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	_, err := client.Stat(context.Background(), &pb.StatRequest{Path: "nonexistent.txt"})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

// --- ListDir tests ---

func TestListDir_WithEntries(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	require.NoError(t, os.WriteFile(filepath.Join(tmp, "a.txt"), []byte("aaa"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "b.txt"), []byte("bb"), 0644))
	require.NoError(t, os.Mkdir(filepath.Join(tmp, "subdir"), 0755))

	resp, err := client.ListDir(context.Background(), &pb.ListDirRequest{Path: "."})
	require.NoError(t, err)

	assert.Len(t, resp.GetEntries(), 3)

	names := make(map[string]*pb.FileInfo)
	for _, e := range resp.GetEntries() {
		names[e.GetName()] = e
	}

	aEntry := names["a.txt"]
	require.NotNil(t, aEntry)
	assert.Equal(t, int64(3), aEntry.GetSize())
	assert.False(t, aEntry.GetIsDir())

	bEntry := names["b.txt"]
	require.NotNil(t, bEntry)
	assert.Equal(t, int64(2), bEntry.GetSize())

	subdirEntry := names["subdir"]
	require.NotNil(t, subdirEntry)
	assert.True(t, subdirEntry.GetIsDir())
}

func TestListDir_EmptyDirectory(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	resp, err := client.ListDir(context.Background(), &pb.ListDirRequest{Path: "."})
	require.NoError(t, err)
	assert.Empty(t, resp.GetEntries())
}

func TestListDir_NotFound(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	_, err := client.ListDir(context.Background(), &pb.ListDirRequest{Path: "nonexistent"})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestListDir_NotADirectory(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	require.NoError(t, os.WriteFile(filepath.Join(tmp, "file.txt"), []byte("data"), 0644))

	_, err := client.ListDir(context.Background(), &pb.ListDirRequest{Path: "file.txt"})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

// --- ReadFile tests ---

func TestReadFile_SmallFile(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	content := []byte("hello world from ReadFile test")
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "small.txt"), content, 0644))

	stream, err := client.ReadFile(context.Background(), &pb.ReadFileRequest{Path: "small.txt"})
	require.NoError(t, err)

	var collected []byte
	var gotEof bool
	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		collected = append(collected, resp.GetData()...)
		if resp.GetEof() {
			gotEof = true
			break
		}
	}

	assert.True(t, gotEof)
	assert.Equal(t, content, collected)
}

func TestReadFile_LargeFile(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	content := []byte(strings.Repeat("X", 100_000))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "large.bin"), content, 0644))

	stream, err := client.ReadFile(context.Background(), &pb.ReadFileRequest{Path: "large.bin"})
	require.NoError(t, err)

	var collected []byte
	chunkCount := 0
	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		collected = append(collected, resp.GetData()...)
		chunkCount++
		if resp.GetEof() {
			break
		}
	}

	assert.Equal(t, content, collected)
	assert.Greater(t, chunkCount, 1, "file should be split into multiple chunks")
}

func TestReadFile_EmptyFile(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	require.NoError(t, os.WriteFile(filepath.Join(tmp, "empty.txt"), []byte{}, 0644))

	stream, err := client.ReadFile(context.Background(), &pb.ReadFileRequest{Path: "empty.txt"})
	require.NoError(t, err)

	resp, err := stream.Recv()
	require.NoError(t, err)
	assert.True(t, resp.GetEof())
	assert.Empty(t, resp.GetData())
}

func TestReadFile_NotFound(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	stream, err := client.ReadFile(context.Background(), &pb.ReadFileRequest{Path: "nonexistent.txt"})
	if err == nil {
		_, err = stream.Recv()
	}
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

// --- WriteFile tests ---

func TestWriteFile_SingleChunk(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	content := []byte("written via gRPC WriteFile")

	stream, err := client.WriteFile(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.WriteFileRequest{
		Path: "written.txt",
		Mode: 0644,
		Data: content,
	})
	require.NoError(t, err)

	resp, err := stream.CloseAndRecv()
	require.NoError(t, err)
	assert.Equal(t, int64(len(content)), resp.GetBytesWritten())

	actual, err := os.ReadFile(filepath.Join(tmp, "written.txt"))
	require.NoError(t, err)
	assert.Equal(t, content, actual)
}

func TestWriteFile_MultipleChunks(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	stream, err := client.WriteFile(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.WriteFileRequest{
		Path: "multi.txt",
		Mode: 0644,
		Data: []byte("chunk1-"),
	})
	require.NoError(t, err)

	err = stream.Send(&pb.WriteFileRequest{Data: []byte("chunk2-")})
	require.NoError(t, err)
	err = stream.Send(&pb.WriteFileRequest{Data: []byte("chunk3")})
	require.NoError(t, err)

	resp, err := stream.CloseAndRecv()
	require.NoError(t, err)
	assert.Equal(t, int64(20), resp.GetBytesWritten())

	actual, err := os.ReadFile(filepath.Join(tmp, "multi.txt"))
	require.NoError(t, err)
	assert.Equal(t, "chunk1-chunk2-chunk3", string(actual))
}

func TestWriteFile_CreatesParentDirs(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	stream, err := client.WriteFile(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.WriteFileRequest{
		Path: "a/b/c/deep.txt",
		Data: []byte("deep"),
	})
	require.NoError(t, err)

	resp, err := stream.CloseAndRecv()
	require.NoError(t, err)
	assert.Equal(t, int64(4), resp.GetBytesWritten())

	actual, err := os.ReadFile(filepath.Join(tmp, "a", "b", "c", "deep.txt"))
	require.NoError(t, err)
	assert.Equal(t, "deep", string(actual))
}

func TestWriteFile_DefaultMode(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	stream, err := client.WriteFile(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.WriteFileRequest{
		Path: "default-mode.txt",
		Data: []byte("test"),
	})
	require.NoError(t, err)

	_, err = stream.CloseAndRecv()
	require.NoError(t, err)

	info, err := os.Stat(filepath.Join(tmp, "default-mode.txt"))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0644), info.Mode().Perm())
}

func TestWriteFile_MissingPath(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	stream, err := client.WriteFile(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.WriteFileRequest{Data: []byte("data")})
	require.NoError(t, err)

	_, err = stream.CloseAndRecv()
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

// --- MakeDir tests ---

func TestMakeDir_NewDirectory(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	_, err := client.MakeDir(context.Background(), &pb.MakeDirRequest{Path: "a/b/c"})
	require.NoError(t, err)

	info, err := os.Stat(filepath.Join(tmp, "a", "b", "c"))
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

func TestMakeDir_AlreadyExists(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	_, err := client.MakeDir(context.Background(), &pb.MakeDirRequest{Path: "."})
	require.NoError(t, err)
}

func TestMakeDir_CustomMode(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	_, err := client.MakeDir(context.Background(), &pb.MakeDirRequest{Path: "custom-mode", Mode: 0700})
	require.NoError(t, err)

	info, err := os.Stat(filepath.Join(tmp, "custom-mode"))
	require.NoError(t, err)
	assert.True(t, info.IsDir())
	assert.Equal(t, os.FileMode(0700), info.Mode().Perm())
}

// --- Remove tests ---

func TestRemove_File(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	require.NoError(t, os.WriteFile(filepath.Join(tmp, "to-delete.txt"), []byte("bye"), 0644))

	_, err := client.Remove(context.Background(), &pb.RemoveRequest{Path: "to-delete.txt"})
	require.NoError(t, err)

	_, err = os.Stat(filepath.Join(tmp, "to-delete.txt"))
	assert.True(t, os.IsNotExist(err))
}

func TestRemove_EmptyDir(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	require.NoError(t, os.Mkdir(filepath.Join(tmp, "empty-dir"), 0755))

	_, err := client.Remove(context.Background(), &pb.RemoveRequest{Path: "empty-dir"})
	require.NoError(t, err)

	_, err = os.Stat(filepath.Join(tmp, "empty-dir"))
	assert.True(t, os.IsNotExist(err))
}

func TestRemove_NonEmptyDirNonRecursive(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	dir := filepath.Join(tmp, "non-empty")
	require.NoError(t, os.Mkdir(dir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "file.txt"), []byte("data"), 0644))

	_, err := client.Remove(context.Background(), &pb.RemoveRequest{Path: "non-empty", Recursive: false})
	require.Error(t, err)
}

func TestRemove_RecursiveDir(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	require.NoError(t, os.MkdirAll(filepath.Join(tmp, "recursive-del", "sub"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "recursive-del", "sub", "file.txt"), []byte("data"), 0644))

	_, err := client.Remove(context.Background(), &pb.RemoveRequest{Path: "recursive-del", Recursive: true})
	require.NoError(t, err)

	_, err = os.Stat(filepath.Join(tmp, "recursive-del"))
	assert.True(t, os.IsNotExist(err))
}

func TestRemove_NotFound(t *testing.T) {
	tmp := t.TempDir()
	client, cleanup := setupFileTestServer(t, tmp)
	defer cleanup()

	_, err := client.Remove(context.Background(), &pb.RemoveRequest{Path: "nonexistent"})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}
