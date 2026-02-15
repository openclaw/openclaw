# Raspberry Pi Docker Setup

This document provides a complete guide to setting up the Money Maker Bot project on your Raspberry Pi using Docker.

## Prerequisites

- Ensure you have Docker installed on your Raspberry Pi. If not, you can install Docker by running:
  ```bash
  curl -fsSL https://get.docker.com -o get-docker.sh
  sh get-docker.sh
  ```
- Install Docker Compose (if required):
  ```bash
  sudo apt-get install -y libffi-dev libssl-dev
  docker-compose
  ```

## Step 1: Clone the Repository

Start by cloning the project repository:

```bash
git clone https://github.com/ianalloway/Money-maker-bot.git
cd Money-maker-bot
```

## Step 2: Configure Environment Variables

- Create a `.env` file to manage your environment variables. You can copy the `.env.example` file included in the repository:
  ```bash
  cp .env.example .env
  ```
- Edit the `.env` file to specify your configurations. You can use a text editor like `nano` or `vim`:
  ```bash
  nano .env
  ```

## Step 3: Build the Docker Image

Now, build the Docker image for the application:

```bash
docker-compose build
```

## Step 4: Start the Application

Start the application using Docker Compose:

```bash
docker-compose up -d
```

## Step 5: Accessing the Application

- You can access the application via the specified ports in the Docker setup.
- Check the logs to see if everything is running smoothly:

```bash
docker-compose logs
```

## Step 6: Stopping the Application

If you need to stop the application, run:

```bash
docker-compose down
```

## Additional Notes

- Ensure your Raspberry Pi is connected to the internet and has sufficient resources to run Docker containers.
- Review Docker documentation for advanced configuration options.

Follow these steps to successfully set up the Money Maker Bot on your Raspberry Pi using Docker!
