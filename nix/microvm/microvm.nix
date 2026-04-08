# nix/microvm/microvm.nix
#
# Parametric MicroVM generator for OpenClaw.
# Creates minimal, hardened NixOS VMs running the OpenClaw gateway.
#
# Parameters:
#   variant      - "gateway" or "gateway-ollama"
#   networking   - "user" (port forwarding) or "tap" (direct network)
#   debugMode    - Enable password auth + virtio console (default: true)
#
# Usage from flake.nix:
#   nix run .#openclaw-microvm           Start gateway VM
#   nix run .#openclaw-microvm-ollama    Start gateway + Ollama VM
#
# Debugging (virtio console — high speed, no SSH needed):
#   socat -,rawer tcp:localhost:15500    Connect to gateway VM console
#   socat -,rawer tcp:localhost:15510    Connect to gateway-ollama VM console
#
# Returns the microvm.declaredRunner — a script that starts the VM.
#
{
  pkgs,
  lib,
  openclaw,
  microvm,
  nixpkgs,
  system,
  ollamaPkg ? null,
  variant ? "gateway",
  networking ? "user",
  debugMode ? false,
}:
let
  sharedConstants = import ../constants.nix;
  vmConstants = import ./constants.nix;
  variantDef = vmConstants.variants.${variant};
  useTap = networking == "tap";
  hostname = vmConstants.getHostname variant;
  consolePorts = vmConstants.getConsolePorts variant;

  vmConfig = nixpkgs.lib.nixosSystem {
    inherit system;
    specialArgs = { inherit openclaw; };

    modules = [
      # MicroVM infrastructure
      microvm.nixosModules.microvm

      # OpenClaw NixOS service modules (gateway + hardening)
      ../modules

      # OpenClaw gateway configuration
      (
        { openclaw, ... }:
        {
          services.openclaw-gateway = {
            enable = true;
            package = openclaw;
            settings.port = lib.toInt sharedConstants.ports.openclaw-gateway;
            settings.host = "0.0.0.0"; # VM needs all-interfaces for host→guest port forwarding
          };
        }
      )

      # Ollama service (optional, for gateway-ollama variant)
      (
        { pkgs, ... }:
        lib.mkIf variantDef.enableOllama {
          # Ollama is available via nixpkgs
          services.ollama = {
            enable = true;
            host = "127.0.0.1";
            port = lib.toInt sharedConstants.ports.ollama;
          };
          # Open firewall for internal communication
          networking.firewall.allowedTCPPorts = [ (lib.toInt sharedConstants.ports.ollama) ];
        }
      )

      # MicroVM and system configuration
      (
        { config, pkgs, ... }:
        {
          system.stateVersion = "26.05";
          nixpkgs.hostPlatform = system;

          microvm = {
            hypervisor = "qemu";
            mem = vmConstants.ram;
            vcpu = vmConstants.vcpus;

            # Share host's nix store read-only
            shares = [
              {
                tag = "ro-store";
                source = "/nix/store";
                mountPoint = "/nix/.ro-store";
                proto = "9p";
              }
            ];

            # Network interface
            interfaces =
              if useTap then
                [
                  {
                    type = "tap";
                    id = "oclawtap0";
                    mac = "02:00:00:0c:1a:01";
                  }
                ]
              else
                [
                  {
                    type = "user";
                    id = "eth0";
                    mac = "02:00:00:0c:1a:01";
                  }
                ];

            # Port forwarding for user-mode networking
            forwardPorts = lib.optionals (!useTap) (
              [
                {
                  from = "host";
                  host.port = (lib.toInt sharedConstants.ports.openclaw-gateway) + variantDef.portOffset;
                  guest.port = lib.toInt sharedConstants.ports.openclaw-gateway;
                }
              ]
              ++ lib.optionals variantDef.enableOllama [
                {
                  from = "host";
                  host.port = (lib.toInt sharedConstants.ports.ollama) + variantDef.portOffset;
                  guest.port = lib.toInt sharedConstants.ports.ollama;
                }
              ]
            );

            # Serial console via TCP — high-speed debugging without SSH.
            # Connect: socat -,rawer tcp:localhost:<port>
            qemu = {
              serialConsole = false;
              extraArgs = [
                "-name"
                "${hostname},process=${hostname}"
                "-serial"
                "tcp:127.0.0.1:${toString consolePorts.serial},server,nowait"
                "-device"
                "virtio-serial-pci"
                "-chardev"
                "socket,id=virtcon,port=${toString consolePorts.virtio},host=127.0.0.1,server=on,wait=off"
                "-device"
                "virtconsole,chardev=virtcon"
              ];
            };
          };

          # Console output on both serial and virtio
          boot.kernelParams = [
            "console=ttyS0,115200"
            "console=hvc0"
          ];

          networking.hostName = hostname;

          # Firewall: open the gateway port
          networking.firewall.allowedTCPPorts = [
            (lib.toInt sharedConstants.ports.openclaw-gateway)
          ];
        }
      )

      # Debug mode — password auth + MOTD for interactive testing
      (lib.mkIf debugMode {
        warnings = [
          "OpenClaw MicroVM is running in DEBUG MODE with insecure SSH settings!"
        ];

        services.openssh = {
          enable = true;
          settings = {
            PasswordAuthentication = lib.mkForce true;
            PermitRootLogin = lib.mkForce "yes";
            KbdInteractiveAuthentication = lib.mkForce true;
          };
        };

        users.users.root.password = vmConstants.sshPassword;

        environment.etc."motd".text = ''
          =============================================
            OpenClaw MicroVM — ${variantDef.description}
          =============================================

          Gateway:   http://localhost:${sharedConstants.ports.openclaw-gateway}
          ${lib.optionalString variantDef.enableOllama "Ollama:    http://localhost:${sharedConstants.ports.ollama}"}

          Useful commands:
            systemctl status openclaw-gateway
            journalctl -u openclaw-gateway -f
            systemd-analyze security openclaw-gateway

          WARNING: DEBUG MODE — password auth is enabled.
          Do NOT use in production.
        '';
      })
    ];
  };
in
vmConfig.config.microvm.declaredRunner
