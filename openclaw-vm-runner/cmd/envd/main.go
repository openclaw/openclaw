// Package main provides the entry point for the envd guest agent.
// envd runs inside a Firecracker MicroVM and exposes gRPC services
// over virtio-vsock for command execution and filesystem operations.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/openclaw/vm-runner/internal/envd"
)

func main() {
	useTCP := flag.Bool("tcp", false, "Listen on TCP localhost:50051 instead of vsock (for local development)")
	port := flag.Uint("port", 50051, "Port to listen on (vsock or TCP)")
	flag.Parse()

	var lis net.Listener
	var err error

	if *useTCP {
		log.Println("WARNING: TCP mode is for development only — gRPC API is unauthenticated on localhost")
		addr := fmt.Sprintf("localhost:%d", *port)
		lis, err = net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("Failed to listen on TCP %s: %v", addr, err)
		}
		log.Printf("envd listening on TCP %s (development mode)", addr)
	} else {
		lis, err = envd.NewVsockListener(uint32(*port))
		if err != nil {
			log.Fatalf("Failed to create vsock listener on port %d: %v", *port, err)
		}
		log.Printf("envd listening on vsock port %d", *port)
	}

	srv := envd.NewServer()

	// Graceful shutdown on SIGTERM/SIGINT.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("Received signal %v, shutting down...", sig)
		srv.GRPC.GracefulStop()
	}()

	log.Println("envd ready")
	if err := srv.GRPC.Serve(lis); err != nil {
		fmt.Fprintf(os.Stderr, "envd server error: %v\n", err)
		os.Exit(1)
	}
}
