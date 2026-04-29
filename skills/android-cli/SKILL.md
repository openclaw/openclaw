---
name: android-cli
description: Orchestrates Android development tasks including project creation, deployment, SDK management, and environment diagnostics using the `android` command-line tool.
---
# Android CLI Specialist

This skill provides instructions for using the `android` CLI tool. The tool includes various commands for creating projects, running applications, interacting with devices, and managing the CLI environment.

## SDK management
To manage the installation of Android SDKs and tools, use the `sdk` command. For example:

- `android sdk install <package>[@<version>]...`: Install specific packages. Multiple packages can be specified, separated by spaces. `<version>` defaults to latest. For example: `android sdk install platforms/android-30@2 platforms/android-34`
- `android sdk update [<pkg-name>]`: Update a specific package or all packages to the latest version.
- `android sdk remove <pkg-name>`: Remove a package from the local SDK.
- `android sdk list --all`: List installed and available SDK packages.

## Project creation
Create projects from templates using the `create` command.

For example: `android create empty-activity --name="My App" --output=./my-app`

## Interacting with devices
For more information on interacting with running devices, see [here](references/interact.md)

## Running journey tests
For more information on running journeys, see [here](references/journeys.md)

## Doc searching
The `docs` command searches authoritative, high-quality Android developer documentation in the Android Knowledge Base.
By providing a few keywords, this tool will return high quality articles that contain examples or guidance on how to use Android APIs or libraries.
Use this tool to obtain additional information on how to achieve Android-specific tasks or to know more about Android APIs, surfaces, libraries, or devices.

Always use this tool to get the most up-to-date information about Android concepts. Typical good use cases are:
  - Finding migration guides for APIs.
  - Finding examples for APIs.
  - Finding up-to-date information about Android APIs.
  - Finding best practices for Android concepts.

## Running APKs
Use the `run` command to run Android apps.

## Managing emulators

Manage Android Virtual Devices (AVDs) using the `android emulator` command

## Capturing screenshots

Capture an image of the current screen of a connected Android device and output it to a file using the `android screenshot` command.

## Managing skills

Manage antigravity agent skills for Android using the `android skills` command.

## Inspecting UI Layouts

Use the `android layout` command to inspect the UI layout of an Android application. It returns the layout tree of an Android application in JSON format. When debugging UI errors, this is often a much faster approach than taking a screenshot.

## Updating the CLI

Update the Android CLI using the `android update` command.

# `android help` output

Usage: android [-hV] [--sdk=PARAM] [COMMAND]
  -h, --help        Show this help message and exit.
      --sdk=PARAM   Path to the Android SDK
  -V, --version     Print version information and exit.
Commands:
  create    Create a new Android project
  describe  Analyzes an Android project to generate descriptive metadata.
  docs      Android documentation commands
  emulator  Emulator commands
  help      Shows the help of all commands
  info      Print environment information (SDK Location, etc.)
  init      Initializes the environment (eg. skills) for Android CLI.
  layout    Returns the layout tree of an application
  run       Deploy an Android Application
  screen    Commands to view the device
  sdk       Download and list SDK packages
  skills    Manage skills
  update    Update the Android CLI

create
          Usage: android create [-h] [--verbose] [--list] [--minSdk=api]
                                --name=applicationName [-o=dest-path] [template-name]
          Create a new Android project
                [template-name]      The template name
            -h, --help               Show this help message and exit.
                --minSdk=api         The 'minSdk' supported by the application (default
                                       is defined in the template)
                --name=applicationName
                                     The name of the application (e.g. 'My Application')
            -o, --output=dest-path   The destination project directory path (default is
                                       '.')
                --verbose            Enables verbose output
                --list               List all available templates

describe
          Usage: android describe [-hV] [--project_dir=PARAM]
          Analyzes an Android project to generate descriptive metadata.
          This command identifies and outputs the paths to JSON files that detail the
          project's structure, including build targets and their corresponding output
          artifact locations (e.g., APKs). This information enables other tools and
          commands to locate build artifacts efficiently.
            -h, --help                Show this help message and exit.
                --project_dir=PARAM   The project directory to describe
            -V, --version             Print version information and exit.

docs
          Usage: android docs [-h] [COMMAND]
          Android documentation commands
            -h, --help   Show this help message and exit.
          Commands:
            search  Search Android documentation
            fetch   Fetch Android documentation

emulator
          Usage: android emulator [-h] [COMMAND]
          Emulator commands
            -h, --help   Show this help message and exit.
          Commands:
            create  Creates a virtual device
            start   Launches the specified virtual device. This command will return when
                      the emulator is fully started and ready to use.
            stop    Stops the specified virtual device
            list    Lists available virtual devices
            remove  Delete a virtual device

help
          Usage: android help [COMMAND]
          Shows the help of all commands
                [COMMAND]   The command to show help for

info
          Usage: android info <field>
          Print environment information (SDK Location, etc.)
                <field>   The specific field to print the value of. If omitted print all.

init
          Usage: android init
          Initializes the environment (eg. skills) for Android CLI.

layout
          Usage: android layout [-dhp] [--device=PARAM] [-o=PARAM]
          Returns the layout tree of an application
            -d, --diff           Returns a flat list of the layout elements that have
                                   changed since the last invocation of ui-dump
                --device=PARAM   The device serial number
            -h, --help           Show this help message and exit.
            -o, --output=PARAM   Writes the layout tree to the specified file or
                                   directory. If omitted, prints the tree to standard
                                   output
            -p, --pretty         Pretty-prints the returned JSON

run
          Usage: android run [-h] [--debug] [--activity=PARAM] [--device=PARAM]
                             [--type=PARAM] [--apks=PARAM[,PARAM...]]...
          Deploy an Android Application
                --activity=PARAM   The activity name
                --apks=PARAM[,PARAM...]
                                   The paths to the APKs
                --debug            Run in debug mode
                --device=PARAM     The device serial number
            -h, --help             Show this help message and exit.
                --type=PARAM       The component type (ACTIVITY, SERVICE, etc.)

screen
          Usage: android screen [-h] [COMMAND]
          Commands to view the device
            -h, --help   Show this help message and exit.
          Commands:
            capture  Outputs the device screen to a PNG
            resolve  Target UI elements visually

sdk
          Usage: android sdk [COMMAND]
          Download and list SDK packages
          Commands:
            install  Install SDK packages
            update   Update one or all packages to the latest version
            remove   Remove a package from the SDK
            list     List installed and available SDK packages

skills
          Usage: android skills [COMMAND]
          Manage skills
          Commands:
            add     Install a skill
            remove  Remove a skill
            list    List available skills
            find    Find skills by keyword

update
          Usage: android update [--url=PARAM]
          Update the Android CLI
                --url=PARAM   The URL to download the update from

